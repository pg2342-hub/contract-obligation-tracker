"use strict";

// Review state lives in this browser only (localStorage). The schedule itself comes from
// data/schedule.json, which tools/build_schedule.py writes after checking every quote.

const STORE_KEY = "cot.reviews.v1";
const NAME_KEY = "cot.reviewer.v1";

const state = {
  schedule: null,
  docs: {},
  reviews: loadJSON(STORE_KEY, {}),
  reviewer: loadJSON(NAME_KEY, ""),
  today: initialToday(),
  tab: "review",
};

function loadJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    return raw ? JSON.parse(raw) : fallback;
  } catch (e) {
    return fallback;
  }
}
function saveJSON(key, value) {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch (e) { /* storage blocked: keep in memory */ }
}
function initialToday() {
  const p = new URLSearchParams(location.search).get("today");
  if (p && /^\d{4}-\d{2}-\d{2}$/.test(p)) return p;
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// ---------- helpers ----------

const $ = (sel) => document.querySelector(sel);
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === false || v == null) continue;
    if (k === "class") el.className = v;
    else if (k.startsWith("on")) el.addEventListener(k.slice(2), v);
    else if (k === "checked" || k === "disabled") el[k] = !!v;
    else el.setAttribute(k, v === true ? "" : v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}
function daysBetween(a, b) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 86400000);
}
function fmtDate(iso) {
  const d = new Date(iso + "T00:00:00Z");
  return d.toLocaleDateString("en-US", { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" });
}
function agreementOf(o) { return state.schedule.agreements.find((a) => a.id === o.agreement); }
function review(id) { return state.reviews[id] || { status: "unverified", checks: {} }; }
function setReview(id, r) { state.reviews[id] = r; saveJSON(STORE_KEY, state.reviews); render(); }
function docTitle(docId) {
  const text = state.docs[docId] || "";
  const m = text.match(/^#\s+(.+)$/m);
  return m ? m[1] : docId;
}

function checksFor(o) {
  const list = [
    { key: "quote", label: "Source clause says this" },
    { key: "owner", label: "Owner is right" },
  ];
  list.push(o.kind === "dated"
    ? { key: "date", label: "Date rule and reading are right" }
    : { key: "trigger", label: "Trigger is right" });
  list.push({ key: "action", label: "Action is right" });
  return list;
}

// Next occurrence on or after today, else the last one.
function nextOccurrence(o) {
  const occ = o.occurrences || [];
  return occ.find((x) => x.date >= state.today) || occ[occ.length - 1];
}
function urgency(date, alertDays) {
  const d = daysBetween(state.today, date);
  if (d < 0) return { cls: "", text: "Passed" };
  if (d === 0) return { cls: "bad", text: "Due today" };
  if (d <= (alertDays || 14)) return { cls: "warn", text: `Due in ${d} day${d === 1 ? "" : "s"}` };
  return { cls: "", text: `In ${d} days` };
}

// ---------- source panel ----------

function escapeRegExp(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function openSource(docId, quoteText) {
  const raw = state.docs[docId] || "Document not loaded.";
  const body = $("#source-body");
  body.textContent = "";
  const pattern = quoteText
    ? new RegExp(quoteText.trim().split(/\s+/).map(escapeRegExp).join("\\s+"))
    : null;
  const m = pattern ? pattern.exec(raw) : null;
  const appendText = (t) => {
    // Show the provenance comment at the top as a note.
    const parts = t.split(/(<!--[\s\S]*?-->)/);
    for (const p of parts) {
      if (p.startsWith("<!--")) body.append(h("span", { class: "note" }, p.replace(/<!--\s*|\s*-->/g, "")));
      else body.append(p);
    }
  };
  let markEl = null;
  if (m) {
    appendText(raw.slice(0, m.index));
    markEl = h("mark", {}, m[0]);
    body.append(markEl);
    appendText(raw.slice(m.index + m[0].length));
  } else {
    appendText(raw);
  }
  $("#source-title").textContent = `${docTitle(docId)} (${docId}.md)`;
  $("#source").hidden = false;
  if (markEl) markEl.scrollIntoView({ block: "center" });
  else body.scrollTop = 0;
}
$("#source-close").addEventListener("click", () => { $("#source").hidden = true; });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") $("#source").hidden = true; });

// ---------- rendering ----------

function render() {
  renderStats();
  for (const t of ["review", "deadlines", "agreements", "how"]) {
    $(`#tab-${t}`).hidden = state.tab !== t;
    document.querySelector(`[data-tab="${t}"]`).setAttribute("aria-selected", String(state.tab === t));
  }
  if (state.tab === "review") { renderReview(); updateVerifyButtons(); }
  if (state.tab === "deadlines") renderDeadlines();
  if (state.tab === "agreements") renderAgreements();
}

function counts() {
  const obs = state.schedule.obligations;
  const c = { total: obs.length, verified: 0, rejected: 0, unverified: 0 };
  for (const o of obs) c[review(o.id).status]++;
  return c;
}

function renderStats() {
  const c = counts();
  const checks = state.schedule.checks;
  const next = verifiedOccurrences().find((x) => x.date >= state.today);
  const el = $("#stats");
  el.textContent = "";
  el.append(
    h("div", { class: "stat" }, h("div", { class: "n" }, `${c.verified} / ${c.total}`), h("div", { class: "l" }, "obligations verified by a person")),
    h("div", { class: "stat" }, h("div", { class: "n" }, String(c.unverified)), h("div", { class: "l" }, "waiting for review (no alerts until verified)")),
    h("div", { class: "stat" }, h("div", { class: "n" }, `${checks.quotes_found_word_for_word} / ${checks.quotes_found_word_for_word}`), h("div", { class: "l" }, "quoted clauses found word for word in the source")),
    h("div", { class: "stat" },
      h("div", { class: "n" }, next ? fmtDate(next.date) : "None"),
      h("div", { class: "l" }, next ? `next verified deadline: ${next.o.title}` : "next verified deadline (verify an item to see it)")),
  );
}

function renderReview() {
  const root = $("#tab-review");
  root.textContent = "";
  root.append(h("div", { class: "toolbar" },
    h("label", { for: "reviewer" }, "Reviewer"),
    h("input", {
      id: "reviewer", class: "text", placeholder: "Your initials (recorded on sign-off)", value: state.reviewer,
      oninput: (e) => { state.reviewer = e.target.value; saveJSON(NAME_KEY, state.reviewer); updateVerifyButtons(); },
    }),
    h("span", { class: "spacer" }),
    h("button", {
      class: "btn ghost",
      onclick: () => { if (confirmReset()) { state.reviews = {}; saveJSON(STORE_KEY, {}); render(); } },
    }, "Reset reviews"),
  ));
  for (const a of state.schedule.agreements) {
    root.append(h("div", { class: "group-title" }, `${a.title} · ${a.type}`));
    for (const o of state.schedule.obligations.filter((x) => x.agreement === a.id)) root.append(obligationCard(o, a));
  }
}

let resetArmed = false;
function confirmReset() {
  // Two-click confirm instead of a browser dialog.
  if (resetArmed) { resetArmed = false; return true; }
  resetArmed = true;
  const b = [...document.querySelectorAll("button")].find((x) => x.textContent === "Reset reviews");
  if (b) { b.textContent = "Click again to clear all reviews"; setTimeout(() => { resetArmed = false; if (b.isConnected) b.textContent = "Reset reviews"; }, 3000); }
  return false;
}

function statusChip(r) {
  if (r.status === "verified") return h("span", { class: "chip ok" }, "Verified");
  if (r.status === "rejected") return h("span", { class: "chip bad" }, "Rejected");
  return h("span", { class: "chip warn" }, "Unverified");
}

function obligationCard(o, a) {
  const r = review(o.id);
  const locked = r.status !== "unverified";
  const card = h("article", { class: `card ${r.status}`, "data-id": o.id });

  const head = h("div", { class: "card-head" },
    h("div", {},
      h("h3", {}, o.title),
      h("div", { class: "meta" }, `${o.category} · ${o.kind === "dated" ? "Dated deadline" : "Triggered by an event"}`)),
    statusChip(r));
  card.append(head);

  const fieldRow = (check, label, valueNodes) => h("div", { class: "field" },
    h("input", {
      type: "checkbox", "aria-label": check.label, checked: !!r.checks[check.key], disabled: locked,
      onchange: (e) => {
        const nr = review(o.id);
        nr.checks = { ...nr.checks, [check.key]: e.target.checked };
        state.reviews[o.id] = nr; saveJSON(STORE_KEY, state.reviews); updateVerifyButtons();
      },
    }),
    h("div", {}, h("div", { class: "k" }, label), h("div", { class: "v" }, valueNodes)));

  const checks = Object.fromEntries(checksFor(o).map((c) => [c.key, c]));

  const quoteNodes = o.quotes.map((q) => h("div", { class: "quote" },
    `“${q.text}”`,
    h("div", { class: "from" },
      h("span", {}, `${docTitle(q.doc)}${q.section ? ` · ${q.section}` : ""}`),
      h("span", {},
        h("span", { class: "auto" }, "✓ found word for word"), " · ",
        h("button", { class: "link", onclick: () => openSource(q.doc, q.text) }, "Open in source")))));

  let whenNodes;
  if (o.kind === "dated") {
    const nx = nextOccurrence(o);
    const shown = o.occurrences.length > 4 ? o.occurrences.filter((x) => x.date >= state.today).slice(0, 3) : o.occurrences;
    whenNodes = [
      h("div", {}, o.interpretation),
      h("ul", { class: "dates" }, shown.map((x) => h("li", {}, h("strong", {}, fmtDate(x.date)), ` · ${x.label}`,
        x === nx && x.date >= state.today ? [" ", h("span", { class: `chip ${urgency(x.date, o.alert_days).cls}` }, urgency(x.date, o.alert_days).text)] : null))),
      o.occurrences.length > shown.length ? h("div", { class: "meta" }, `${o.occurrences.length} dates in total; all appear on the Deadlines tab once verified.`) : null,
      h("div", { class: "meta" }, `Computed from: ${o.rule_terms.map((t) => a.key_terms.find((k) => k.id === t)).map((k) => `${k.label} = ${k.value_text}`).join("; ")}. Alert ${o.alert_days} days ahead.`),
    ];
  } else {
    whenNodes = [h("div", {}, o.event), o.related ? h("div", { class: "meta" }, `Linked to: ${state.schedule.obligations.find((x) => x.id === o.related).title}`) : null];
  }

  card.append(h("div", { class: "fields" },
    fieldRow(checks.quote, "Source clause", quoteNodes),
    fieldRow(checks.owner, "Who must act", o.owner),
    o.kind === "dated" ? fieldRow(checks.date, "When", whenNodes) : fieldRow(checks.trigger, "Trigger", whenNodes),
    fieldRow(checks.action, "Action", o.action)));

  if (r.status === "unverified") {
    const reason = h("input", { class: "text", placeholder: "If rejecting: what is wrong?", "data-reason": o.id });
    card.append(h("div", { class: "actions" },
      h("button", {
        class: "btn", "data-verify": o.id, disabled: true,
        onclick: () => setReview(o.id, { status: "verified", checks: review(o.id).checks, by: state.reviewer.trim(), at: new Date().toISOString() }),
      }, "Verify"),
      reason,
      h("button", {
        class: "btn danger",
        onclick: () => {
          if (!reason.value.trim()) { reason.focus(); reason.placeholder = "Add a reason to reject"; return; }
          setReview(o.id, { status: "rejected", checks: review(o.id).checks, by: state.reviewer.trim() || "unknown", at: new Date().toISOString(), reason: reason.value.trim() });
        },
      }, "Reject")));
  } else {
    card.append(h("div", { class: "signoff" },
      `${r.status === "verified" ? "Verified" : "Rejected"} by ${r.by || "unknown"} on ${new Date(r.at).toLocaleString()}`,
      r.reason ? `. Reason: ${r.reason}` : "",
      " · ",
      h("button", { class: "link", onclick: () => setReview(o.id, { status: "unverified", checks: {} }) }, "Undo")));
  }
  return card;
}

function updateVerifyButtons() {
  for (const btn of document.querySelectorAll("[data-verify]")) {
    const o = state.schedule.obligations.find((x) => x.id === btn.dataset.verify);
    const r = review(o.id);
    const allChecked = checksFor(o).every((c) => r.checks[c.key]);
    const named = state.reviewer.trim().length > 0;
    btn.disabled = !(allChecked && named);
    btn.title = !named ? "Enter your initials first" : !allChecked ? "Check every field first" : "";
  }
}

function verifiedOccurrences() {
  const out = [];
  for (const o of state.schedule.obligations) {
    if (o.kind !== "dated" || review(o.id).status !== "verified") continue;
    for (const x of o.occurrences) out.push({ ...x, o });
  }
  return out.sort((p, q) => p.date.localeCompare(q.date));
}

function renderDeadlines() {
  const root = $("#tab-deadlines");
  root.textContent = "";
  const unverifiedDated = state.schedule.obligations.filter((o) => o.kind === "dated" && review(o.id).status === "unverified").length;
  const occ = verifiedOccurrences();
  const showPast = root.dataset.past === "1";
  const horizon = root.dataset.horizon || "365";
  const rows = occ.filter((x) => (showPast || x.date >= state.today)
    && (horizon === "all" || daysBetween(state.today, x.date) <= Number(horizon)));

  root.append(h("div", { class: "toolbar" },
    h("label", {}, h("input", { type: "checkbox", checked: showPast, onchange: (e) => { root.dataset.past = e.target.checked ? "1" : ""; renderDeadlines(); } }), " Show past dates"),
    h("select", { class: "text", style: "flex:0 0 auto", "aria-label": "How far ahead",
      onchange: (e) => { root.dataset.horizon = e.target.value; renderDeadlines(); } },
      [["90", "Next 90 days"], ["365", "Next 12 months"], ["all", "All dates"]].map(([v, l]) => h("option", { value: v, selected: v === horizon }, l))),
    h("span", { class: "spacer" }),
    h("button", { class: "btn ghost", disabled: !occ.length, onclick: exportCSV }, "Export CSV"),
    h("button", { class: "btn", disabled: !occ.length, onclick: exportICS }, "Add to calendar (.ics)")));

  if (unverifiedDated) {
    root.append(h("p", { class: "banner" }, `${unverifiedDated} dated obligation${unverifiedDated === 1 ? " is" : "s are"} waiting for review and not shown here. Verify ${unverifiedDated === 1 ? "it" : "them"} on the Review queue tab.`));
  }
  if (!rows.length) {
    root.append(h("p", { class: "empty" }, occ.length ? "No upcoming verified deadlines." : "Nothing verified yet. Deadlines appear here only after a person verifies them."));
  } else {
    root.append(h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Date"), h("th", {}, "Obligation"), h("th", {}, "Status"), h("th", {}, "Detail"))),
      h("tbody", {}, rows.map((x) => {
        const u = urgency(x.date, x.o.alert_days);
        return h("tr", {},
          h("td", {}, h("strong", {}, fmtDate(x.date))),
          h("td", {}, x.o.title, h("div", { class: "meta" }, `${agreementOf(x.o).title} · ${x.o.owner}`)),
          h("td", {}, h("span", { class: `chip ${u.cls}` }, u.text)),
          h("td", {}, x.label));
      })))));
  }

  const events = state.schedule.obligations.filter((o) => o.kind === "event" && review(o.id).status === "verified");
  root.append(h("h2", {}, "Watch list: obligations triggered by events"));
  if (!events.length) root.append(h("p", { class: "empty" }, "No verified event obligations yet."));
  else root.append(h("div", { class: "table-wrap" }, h("table", {},
    h("thead", {}, h("tr", {}, h("th", {}, "If this happens"), h("th", {}, "Do this"), h("th", {}, "Agreement"))),
    h("tbody", {}, events.map((o) => h("tr", {}, h("td", {}, o.event), h("td", {}, o.action), h("td", {}, agreementOf(o).title)))))));
}

function renderAgreements() {
  const root = $("#tab-agreements");
  root.textContent = "";
  for (const a of state.schedule.agreements) {
    root.append(h("h2", {}, a.title), h("div", { class: "meta" }, `${a.type} with ${a.counterparty} · documents: `,
      a.docs.map((d, i) => [i ? ", " : "", h("button", { class: "link", onclick: () => openSource(d) }, docTitle(d))])));
    root.append(h("div", { class: "table-wrap" }, h("table", {},
      h("thead", {}, h("tr", {}, h("th", {}, "Key term"), h("th", {}, "Value"), h("th", {}, "Source"))),
      h("tbody", {}, a.key_terms.map((t) => h("tr", {},
        h("td", {}, t.label),
        h("td", {}, h("strong", {}, t.value_text), h("div", { class: "meta" }, t.value)),
        h("td", {}, `“${t.quote.text}” `, h("button", { class: "link", onclick: () => openSource(t.quote.doc, t.quote.text) }, "Open"))))))));
  }
}

// ---------- exports ----------

function download(name, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = h("a", { href: url, download: name });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function csvCell(s) { return `"${String(s).replace(/"/g, '""')}"`; }
function exportCSV() {
  const lines = [["date", "obligation", "agreement", "owner", "detail", "verified_by", "verified_at"].join(",")];
  for (const x of verifiedOccurrences()) {
    const r = review(x.o.id);
    lines.push([x.date, x.o.title, agreementOf(x.o).title, x.o.owner, x.label, r.by, r.at].map(csvCell).join(","));
  }
  download("verified-deadlines.csv", "text/csv", lines.join("\n") + "\n");
}
function icsEscape(s) { return String(s).replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\n/g, "\\n"); }
function exportICS() {
  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");
  const out = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//contract-obligation-tracker//EN", "CALSCALE:GREGORIAN"];
  for (const x of verifiedOccurrences().filter((x) => x.date >= state.today)) {
    const d = x.date.replace(/-/g, "");
    const next = new Date(Date.parse(x.date + "T00:00:00Z") + 86400000).toISOString().slice(0, 10).replace(/-/g, "");
    out.push("BEGIN:VEVENT",
      `UID:${x.o.id.replace(/\//g, "-")}-${d}@contract-obligation-tracker`,
      `DTSTAMP:${stamp}`,
      `DTSTART;VALUE=DATE:${d}`,
      `DTEND;VALUE=DATE:${next}`,
      `SUMMARY:${icsEscape(x.o.title + " (" + agreementOf(x.o).title + ")")}`,
      `DESCRIPTION:${icsEscape(x.o.action + "\n" + x.label + "\nSource: " + x.o.quotes[0].text)}`,
      "BEGIN:VALARM", "ACTION:DISPLAY", `DESCRIPTION:${icsEscape(x.o.title)}`, `TRIGGER:-P${x.o.alert_days || 7}D`, "END:VALARM",
      "END:VEVENT");
  }
  out.push("END:VCALENDAR");
  download("verified-deadlines.ics", "text/calendar", out.join("\r\n") + "\r\n");
}

// ---------- boot ----------

document.querySelectorAll("[data-tab]").forEach((b) => b.addEventListener("click", () => { state.tab = b.dataset.tab; render(); }));
$("#today").value = state.today;
$("#today").addEventListener("change", (e) => { if (e.target.value) { state.today = e.target.value; render(); } });

(async function boot() {
  try {
    state.schedule = await (await fetch("data/schedule.json")).json();
    const ids = [...new Set(state.schedule.agreements.flatMap((a) => a.docs))];
    await Promise.all(ids.map(async (id) => { state.docs[id] = await (await fetch(`data/documents/${id}.md`)).text(); }));
    render();
    updateVerifyButtons();
  } catch (e) {
    $("#tab-review").append(h("p", { class: "empty" }, "Could not load data/schedule.json. Serve this folder over HTTP (for example: python3 -m http.server) rather than opening the file directly."));
  }
})();
