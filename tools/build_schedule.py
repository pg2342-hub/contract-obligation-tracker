"""Check an extraction against its source documents and compute every deadline.

The model only extracts. It never computes a date. This script:
  1. checks that every quoted clause appears word for word in its source document,
  2. checks that every key term's value appears in its own quote and parses to the stored value,
  3. computes each deadline from the key terms with fixed, documented rules,
  4. writes data/schedule.json for the web page.

Any failed check stops the build. Run with --check to confirm data/schedule.json is current
(this is what CI runs).

Usage:
  python tools/build_schedule.py           # write data/schedule.json
  python tools/build_schedule.py --check   # fail if data/schedule.json is stale or a check fails
"""

from __future__ import annotations

import calendar
import json
import re
import sys
from datetime import date, datetime, timedelta
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "data" / "documents"
EXTRACTION = ROOT / "data" / "extraction.json"
SCHEDULE = ROOT / "data" / "schedule.json"


class CheckFailed(Exception):
    pass


def normalize(text: str) -> str:
    """Collapse whitespace and Markdown heading marks so a quote can span line breaks."""
    text = text.replace(" ", " ")
    return re.sub(r"\s+", " ", text).strip()


def load_docs() -> dict[str, str]:
    return {p.stem: normalize(p.read_text(encoding="utf-8")) for p in sorted(DOCS.glob("*.md"))}


# ---------- durations and date math ----------

DURATION = re.compile(r"^P(\d+)([YMD])$")


def parse_duration(value: str) -> tuple[int, str]:
    m = DURATION.match(value)
    if not m:
        raise CheckFailed(f"unsupported duration {value!r} (use PnY, PnM or PnD)")
    return int(m.group(1)), m.group(2)


def add_months(d: date, months: int) -> date:
    """Add calendar months. A day that does not exist in the target month moves to its last day."""
    y, m = divmod(d.month - 1 + months, 12)
    year, month = d.year + y, m + 1
    day = min(d.day, calendar.monthrange(year, month)[1])
    return date(year, month, day)


def add_duration(d: date, value: str, times: int = 1) -> date:
    n, unit = parse_duration(value)
    n *= times
    if unit == "Y":
        return add_months(d, 12 * n)
    if unit == "M":
        return add_months(d, n)
    return d + timedelta(days=n)


def days_of(value: str) -> int:
    n, unit = parse_duration(value)
    if unit != "D":
        raise CheckFailed(f"expected a duration in days, got {value!r}")
    return n


def last_day_of_month(d: date) -> date:
    return date(d.year, d.month, calendar.monthrange(d.year, d.month)[1])


# ---------- checks ----------

DURATION_WORDS = {"Y": ("year", "years"), "M": ("month", "months"), "D": ("day", "days")}


def check_quote(quote: dict, docs: dict[str, str], where: str) -> None:
    doc = quote["doc"]
    if doc not in docs:
        raise CheckFailed(f"{where}: unknown document {doc!r}")
    if normalize(quote["text"]) not in docs[doc]:
        raise CheckFailed(f"{where}: quote not found word for word in {doc}.md: {quote['text'][:80]!r}")


def check_key_term(term: dict, docs: dict[str, str], where: str) -> None:
    check_quote(term["quote"], docs, where)
    vt = term["value_text"]
    if normalize(vt) not in normalize(term["quote"]["text"]):
        raise CheckFailed(f"{where}: value text {vt!r} is not inside its quote")
    value = term["value"]
    if re.match(r"^\d{4}-\d{2}-\d{2}$", value):
        parsed = datetime.strptime(vt, "%B %d, %Y").date().isoformat()
        if parsed != value:
            raise CheckFailed(f"{where}: {vt!r} parses to {parsed}, not {value}")
    elif DURATION.match(value):
        n, unit = parse_duration(value)
        if vt not in (f"{n} {DURATION_WORDS[unit][0]}", f"{n} {DURATION_WORDS[unit][1]}"):
            raise CheckFailed(f"{where}: {vt!r} does not match duration {value}")


# ---------- rules ----------


def occurrences(rule: dict, terms: dict[str, dict]) -> list[dict]:
    def term(name: str) -> str:
        if name not in terms:
            raise CheckFailed(f"rule refers to unknown key term {name!r}")
        return terms[name]["value"]

    kind = rule["type"]
    if kind == "anchor_plus":
        anchor = date.fromisoformat(term(rule["anchor"]))
        due = add_duration(anchor, term(rule["offset"]))
        return [{"date": due.isoformat(), "label": f"{terms[rule['anchor']]['label']} + {terms[rule['offset']]['value_text']}"}]

    if kind == "renewal_notice":
        start = date.fromisoformat(term(rule["anchor"]))
        period, notice = term(rule["period"]), days_of(term(rule["notice"]))
        out = []
        for k in range(1, rule["cycles"] + 1):
            # Conservative reading, used for every notice deadline:
            #   the term's last day is the day before the anniversary,
            #   the Non-Renewal Notice Date is N days before that last day,
            #   notice must arrive *before* that date, so the last safe day is one day earlier.
            last_day = add_duration(start, period, k) - timedelta(days=1)
            notice_date = last_day - timedelta(days=notice)
            last_safe = notice_date - timedelta(days=1)
            next_last = add_duration(start, period, k + 1) - timedelta(days=1)
            out.append({
                "date": last_safe.isoformat(),
                "label": (f"Term {k} runs through {last_day.isoformat()}; Non-Renewal Notice Date "
                          f"{notice_date.isoformat()}; otherwise renews through {next_last.isoformat()}"),
            })
        return out

    if kind == "invoice_due":
        start = date.fromisoformat(term(rule["anchor"]))
        pay = days_of(term(rule["payment"]))
        horizon = add_duration(start, "P12M", rule["cycles"])
        invoices = []
        if rule["schedule"] == "annual_on_anchor":
            invoices = [add_months(start, 12 * k) for k in range(rule["cycles"])]
        elif rule["schedule"] == "monthly_last_day":
            d = last_day_of_month(start)
            while d < horizon:
                invoices.append(d)
                d = last_day_of_month(add_months(date(d.year, d.month, 1), 1))
        else:
            raise CheckFailed(f"unknown invoice schedule {rule['schedule']!r}")
        return [{"date": (i + timedelta(days=pay)).isoformat(), "label": f"Invoice dated {i.isoformat()}"} for i in invoices]

    raise CheckFailed(f"unknown rule type {kind!r}")


# ---------- build ----------


def build(data: dict | None = None) -> dict:
    docs = load_docs()
    if data is None:
        data = json.loads(EXTRACTION.read_text(encoding="utf-8"))
    agreements = {a["id"]: a for a in data["agreements"]}
    if len(agreements) != len(data["agreements"]):
        raise CheckFailed("duplicate agreement id")

    quotes_checked = 0
    for a in data["agreements"]:
        for d in a["docs"]:
            if d not in docs:
                raise CheckFailed(f"{a['id']}: unknown document {d!r}")
        for t in a["key_terms"]:
            if t["quote"]["doc"] not in a["docs"]:
                raise CheckFailed(f"{a['id']}/{t['id']}: quote from {t['quote']['doc']}, which is not part of {a['id']}")
            check_key_term(t, docs, f"{a['id']}/{t['id']}")
            quotes_checked += 1

    seen, obligations = set(), []
    for o in data["obligations"]:
        where = o["id"]
        if where in seen:
            raise CheckFailed(f"duplicate obligation id {where}")
        seen.add(where)
        a = agreements.get(o["agreement"])
        if not a:
            raise CheckFailed(f"{where}: unknown agreement {o['agreement']!r}")
        if not o.get("quotes"):
            raise CheckFailed(f"{where}: every obligation needs at least one source quote")
        for q in o["quotes"]:
            if q["doc"] not in a["docs"]:
                raise CheckFailed(f"{where}: quote from {q['doc']}, which is not part of {a['id']}")
            check_quote(q, docs, where)
            quotes_checked += 1
        out = dict(o)
        if o["kind"] == "dated":
            terms = {t["id"]: t for t in a["key_terms"]}
            out["occurrences"] = occurrences(o["rule"], terms)
            out["rule_terms"] = sorted({v for k, v in o["rule"].items() if isinstance(v, str) and v in terms})
        elif o["kind"] != "event":
            raise CheckFailed(f"{where}: kind must be 'dated' or 'event'")
        obligations.append(out)

    for o in obligations:
        if o.get("related") and o["related"] not in seen:
            raise CheckFailed(f"{o['id']}: related obligation {o['related']!r} does not exist")

    dated = sum(1 for o in obligations if o["kind"] == "dated")
    return {
        "schema_version": data["schema_version"],
        "agreements": data["agreements"],
        "obligations": obligations,
        "checks": {
            "quotes_found_word_for_word": quotes_checked,
            "dated_obligations_computed": dated,
            "event_obligations": len(obligations) - dated,
        },
    }


def main() -> int:
    try:
        schedule = build()
    except CheckFailed as e:
        print(f"CHECK FAILED: {e}", file=sys.stderr)
        return 1
    text = json.dumps(schedule, indent=2, ensure_ascii=False) + "\n"
    c = schedule["checks"]
    summary = (f"{c['quotes_found_word_for_word']} quotes found word for word; "
               f"{c['dated_obligations_computed']} dated and {c['event_obligations']} event obligations")
    if "--check" in sys.argv:
        current = SCHEDULE.read_text(encoding="utf-8") if SCHEDULE.exists() else ""
        if current != text:
            print("CHECK FAILED: data/schedule.json is out of date. Run python tools/build_schedule.py", file=sys.stderr)
            return 1
        print(f"OK: {summary}; schedule.json is current")
        return 0
    SCHEDULE.write_text(text, encoding="utf-8")
    print(f"Wrote data/schedule.json: {summary}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
