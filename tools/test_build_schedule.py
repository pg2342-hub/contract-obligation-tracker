"""Tests for the checks and date rules. Run: python -m unittest discover tools"""

import copy
import json
import sys
import unittest
from datetime import date
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import build_schedule as bs  # noqa: E402

ORIGINAL = json.loads(bs.EXTRACTION.read_text(encoding="utf-8"))


def build_with(mutate):
    data = copy.deepcopy(ORIGINAL)
    mutate(data)
    return bs.build(data)


def obligation(data, oid):
    return next(o for o in data["obligations"] if o["id"] == oid)


class DateMath(unittest.TestCase):
    def test_month_end_clamps(self):
        self.assertEqual(bs.add_months(date(2026, 1, 31), 1), date(2026, 2, 28))
        self.assertEqual(bs.add_months(date(2028, 1, 31), 1), date(2028, 2, 29))

    def test_years_and_days(self):
        self.assertEqual(bs.add_duration(date(2026, 3, 2), "P1Y"), date(2027, 3, 2))
        self.assertEqual(bs.add_duration(date(2026, 1, 5), "P30D"), date(2026, 2, 4))


class Schedule(unittest.TestCase):
    def test_sample_builds_and_dates(self):
        s = build_with(lambda d: None)
        larkspur = obligation(s, "order-larkspur/non-renewal-notice")
        self.assertEqual(larkspur["occurrences"][0]["date"], "2026-12-04")  # term ends 2027-01-04; notice date 2026-12-05; before it
        tamarind = obligation(s, "order-tamarind/non-renewal-notice")
        self.assertEqual(tamarind["occurrences"][0]["date"], "2026-10-14")  # term ends 2026-12-14; notice date 2026-10-15; before it
        self.assertEqual(obligation(s, "nda-kestrel/mnda-expires")["occurrences"][0]["date"], "2027-03-02")

    def test_altered_quote_fails(self):
        def m(d):
            obligation(d, "nda-kestrel/mnda-expires")["quotes"][0]["text"] = "Expires 2 years from Effective Date."
        with self.assertRaises(bs.CheckFailed):
            build_with(m)

    def test_date_that_does_not_match_its_quote_fails(self):
        def m(d):
            d["agreements"][1]["key_terms"][0]["value"] = "2026-01-06"
        with self.assertRaises(bs.CheckFailed):
            build_with(m)

    def test_duration_that_does_not_match_its_quote_fails(self):
        def m(d):
            d["agreements"][1]["key_terms"][2]["value"] = "P31D"
        with self.assertRaises(bs.CheckFailed):
            build_with(m)

    def test_key_term_quote_from_another_agreement_fails(self):
        def m(d):
            d["agreements"][0]["key_terms"][0]["quote"]["doc"] = "order-larkspur"
        with self.assertRaises(bs.CheckFailed):
            build_with(m)

    def test_quote_from_another_agreement_fails(self):
        def m(d):
            obligation(d, "nda-kestrel/mnda-expires")["quotes"].append(
                {"doc": "order-larkspur", "text": "**Order Date:** January 5, 2026"})
        with self.assertRaises(bs.CheckFailed):
            build_with(m)


if __name__ == "__main__":
    unittest.main()
