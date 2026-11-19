"""Extract key terms and obligations from one agreement with Claude.

The model reads the agreement's documents and returns structured JSON: key terms with
their exact source quotes, and obligations described as rules over those terms. It never
computes a date. tools/build_schedule.py then checks every quote against the source text
and computes the deadlines.

Usage:
  pip install -r tools/requirements.txt
  export ANTHROPIC_API_KEY=...
  python tools/extract.py order-larkspur "Larkspur Observability subscription" \
      order-larkspur csa-standard-terms-v3 --our-party "Northbeam Labs, Inc."

The result is merged into data/extraction.json (replacing any agreement with the same id).
Every extracted obligation still starts as unverified in the web page until a person checks it.
"""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Literal, Optional, Union

import anthropic
from pydantic import BaseModel, Field

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / "data" / "documents"
EXTRACTION = ROOT / "data" / "extraction.json"

MODEL = "claude-opus-5-5"


class Quote(BaseModel):
    doc: str = Field(description="Document id (file name without .md) the text is copied from")
    text: str = Field(description="Exact text copied word for word from the document, no paraphrase")
    section: Optional[str] = Field(default=None, description="Section number and heading, if any")


class KeyTerm(BaseModel):
    id: str = Field(description="snake_case id, e.g. effective_date, order_date, subscription_period")
    label: str
    value: str = Field(description="ISO date (YYYY-MM-DD) or ISO duration (PnY, PnM, PnD), or plain text")
    value_text: str = Field(description="The value exactly as written in the quote, e.g. 'January 5, 2026' or '30 days'")
    quote: Quote


class AnchorPlus(BaseModel):
    type: Literal["anchor_plus"]
    anchor: str = Field(description="Key term id of a date")
    offset: str = Field(description="Key term id of a duration")


class RenewalNotice(BaseModel):
    type: Literal["renewal_notice"]
    anchor: str
    period: str
    notice: str = Field(description="Key term id of the notice duration in days")
    cycles: int = 3


class InvoiceDue(BaseModel):
    type: Literal["invoice_due"]
    anchor: str
    schedule: Literal["annual_on_anchor", "monthly_last_day"]
    payment: str = Field(description="Key term id of the payment period in days")
    cycles: int = 3


class Obligation(BaseModel):
    id: str = Field(description="<agreement id>/<short-slug>")
    agreement: str
    title: str
    owner: str = Field(description="Which party must act")
    category: Literal["Term", "Renewal", "Payment", "Confidentiality", "Notice", "Data", "Compliance", "Other"]
    kind: Literal["dated", "event"]
    rule: Optional[Union[AnchorPlus, RenewalNotice, InvoiceDue]] = Field(
        default=None, description="Required for dated obligations; omit for event obligations")
    event: Optional[str] = Field(default=None, description="For event obligations: what triggers it")
    interpretation: Optional[str] = Field(
        default=None, description="For dated obligations: how the rule reads the contract, in plain words, for a person to confirm")
    action: str = Field(description="What our team must do, in one or two plain sentences")
    alert_days: Optional[int] = Field(default=None, description="Days before a dated deadline to start alerting")
    quotes: list[Quote] = Field(description="Every clause this obligation relies on, copied word for word")


class Agreement(BaseModel):
    id: str
    title: str
    counterparty: str
    type: str
    docs: list[str]
    key_terms: list[KeyTerm]


class Extraction(BaseModel):
    agreement: Agreement
    obligations: list[Obligation]


SYSTEM = """You extract contract obligations for an operations team's tracker. A person will verify \
every field you return against the source, and deadlines will be computed by code, so:
- Copy every quote word for word from the documents. Never paraphrase inside a quote.
- Never compute a date. Express each deadline as a rule over key terms.
- If a deadline cannot be expressed with the available rule types, make it an event obligation and say so.
- Include obligations for both parties when they matter to our team (for example, a vendor's deletion duty \
we must trigger).
- Do not give legal advice. Describe what the text says and what action it implies."""


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("agreement_id")
    p.add_argument("title")
    p.add_argument("docs", nargs="+", help="Document ids in data/documents (without .md)")
    p.add_argument("--our-party", required=True)
    args = p.parse_args()

    blocks = []
    for d in args.docs:
        blocks.append({
            "type": "text",
            "text": f'<document id="{d}">\n{(DOCS / f"{d}.md").read_text(encoding="utf-8")}\n</document>',
        })
    blocks.append({
        "type": "text",
        "text": (f"Agreement id: {args.agreement_id}\nTitle: {args.title}\nOur party: {args.our_party}\n"
                 "Extract the key terms and every obligation with a deadline, notice requirement, payment, "
                 "renewal, confidentiality duty or data duty."),
    })

    client = anthropic.Anthropic()
    response = client.messages.parse(
        model=MODEL,
        max_tokens=16000,
        thinking={"type": "adaptive"},
        output_config={"effort": "high"},
        system=SYSTEM,
        messages=[{"role": "user", "content": blocks}],
        output_format=Extraction,
    )
    if response.stop_reason == "refusal":
        raise SystemExit("The model declined this request.")
    result: Extraction = response.parsed_output

    data = json.loads(EXTRACTION.read_text(encoding="utf-8"))
    data["agreements"] = [a for a in data["agreements"] if a["id"] != args.agreement_id]
    data["obligations"] = [o for o in data["obligations"] if o["agreement"] != args.agreement_id]
    data["agreements"].append(result.agreement.model_dump(exclude_none=True))
    data["obligations"].extend(o.model_dump(exclude_none=True) for o in result.obligations)
    EXTRACTION.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    print(f"Merged {len(result.obligations)} obligations for {args.agreement_id}. "
          "Now run: python tools/build_schedule.py")


if __name__ == "__main__":
    main()
