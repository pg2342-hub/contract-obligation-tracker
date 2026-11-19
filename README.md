# Contract Obligation Tracker

Extracts obligations, deadlines and renewal or notice dates from contracts into a tracker. A person verifies every field against the source clause before it can trigger an alert.

**Live demo:** https://pg2342-hub.github.io/contract-obligation-tracker/ (sample agreements with fictional parties; review choices stay in your browser)

## Why it is built this way

A missed non-renewal date usually costs a full contract year, and one missed obligation is the failure that matters. So the design aims for zero misses rather than maximum automation:

1. **The model extracts, it never computes.** Claude returns key terms (dates, terms, notice periods) and obligations as structured data, with the exact clause each one relies on. Deadlines are described as rules, such as "30 days before each anniversary of the Order Date."
2. **Code checks the extraction and computes the dates.** `tools/build_schedule.py` fails the build if any quote is not found word for word in its source document, if a key term's value does not match its own quote ("January 5, 2026" must be 2026-01-05), or if a quote (for a key term or an obligation) comes from a document outside its agreement. It then computes every deadline with fixed, documented rules. CI runs this on every push.
3. **A person verifies every field.** Each obligation starts as unverified. The reviewer opens the highlighted source clause and confirms the clause, the owner, the date rule and how it reads the contract (or the triggering event), and the action, then signs off with their initials. Wrong items are rejected with a reason.
4. **Only verified items reach the calendar.** The deadline list, alerts and the `.ics` and CSV exports include verified obligations only. Unverified deadlines are counted, never shown as reliable.

## What is in the demo

Three sample agreements built on [Common Paper](https://commonpaper.com) templates (CC BY 4.0), with fictional parties:

| Agreement | What it exercises |
|---|---|
| Mutual NDA (Common Paper MNDA v1.0) | Expiry date, confidentiality term with a trade-secret carve-out, return-or-destroy duty, compelled-disclosure notice |
| Cloud service order form, annual fee (CSA v3.0) | Auto-renewal with a 30-day non-renewal notice window that is coming up soon, annual invoice, fee-dispute window, warranty notice, data deletion at exit |
| Cloud service order form, monthly fee (CSA v3.0) | A 60-day notice window that has already passed (so the order renewed), monthly invoices, suspension risk on late payment |

13 obligations (6 dated, 7 triggered by events) and 35 source quotes, all checked automatically.

## Run it

```bash
python3 tools/build_schedule.py --check     # verify quotes and recompute every date
python3 -m unittest discover tools          # tests for the checks and date rules
python3 -m http.server 8000                 # then open http://localhost:8000
```

Add `?today=2026-11-19` to the URL to view the tracker as of a fixed date.

## Extract a new agreement

```bash
pip install -r tools/requirements.txt
export ANTHROPIC_API_KEY=...
python3 tools/extract.py order-larkspur "Larkspur Observability subscription" \
    order-larkspur csa-standard-terms-v3 --our-party "Northbeam Labs, Inc."
python3 tools/build_schedule.py
```

`extract.py` uses structured outputs, so the result always matches the schema, and it merges the result into `data/extraction.json`. The sample extraction in this repository was prepared for the demo and passes every check in `build_schedule.py`. The live extraction path has been tested against a mocked API response, not yet against the live API.

## Layout

```
index.html, app.js, style.css   the tracker (static, no build step)
data/documents/                 source documents (Markdown)
data/extraction.json            extracted key terms and obligations, with quotes
data/schedule.json              checked and computed schedule the page reads
tools/extract.py                extraction with Claude
tools/build_schedule.py         checks and date rules
tools/test_build_schedule.py    tests
```

## Date conventions

Notice deadlines are read conservatively, because a notice that arrives one day late is a missed notice. A term of 12 months from a start date runs through the day before the anniversary. A notice date set "at least N days before the end" of a term is N calendar days before that last day, and where notice must be given *before* that date, the tracker shows the day before it as the last safe day for delivery. Expiry dates ("expires 1 year from") are shown on the anniversary. A month-end start date moves to the last day of shorter months. Each dated obligation states its reading of the contract in plain words, and the reviewer confirms that reading as part of the date check. Readings that could go two ways belong with a lawyer, not the tool.

## Licenses

Code: MIT. Documents: see [data/NOTICE.md](data/NOTICE.md). Nothing here is legal advice.
