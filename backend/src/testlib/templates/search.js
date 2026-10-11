import { apiCalls, check, errorChecks, failedCalls, jsErrors, listCalls, listConsole } from "../checks.js";
import { elementLabel, isTextish } from "../elements.js";

const SEARCHY = /search|query|^q$|find|keyword/i;
const SPECIAL = `bugops"<'%&>`;

function searchField(el) {
  const fields = el.form.fields.filter(isTextish);
  return (
    fields.find((f) => (f.type || "").toLowerCase() === "search") ||
    fields.find((f) => SEARCHY.test(`${f.name || ""} ${f.placeholder || ""} ${f.label || ""}`)) ||
    fields[0]
  );
}

export default {
  id: "search",
  name: "Search runs and handles special characters",
  scope: "element",
  categories: ["search"],
  kinds: ["form", "input"],
  requires: [],
  onePerPage: true,
  severity: "high",
  judge: true,
  spec: {
    action: "Type a term into the search field and submit; repeat with special characters",
    expectedNetwork: "A request carrying the term (URL or body) returns HTTP < 400, or the URL gains the term",
    expectedStateChange: "Results area / URL updates; special characters don't break the page",
    persistsOnReload: "If the term is in the URL, reloading shows the same search",
  },
  fixHint: "Make sure the search handler runs on submit, escapes user input before using it (RegExp, HTML, SQL), and encodes the term in the URL so results are linkable.",

  appliesTo(el) {
    return (el.kind === "form" || el.kind === "input") && el.form.fields.some(isTextish);
  },

  async run(t, el) {
    const label = elementLabel(el);
    const term = t.options.searchTerm || "test";
    const field = searchField(el);

    await t.fresh();
    // Search often POSTs (GraphQL, search APIs); allow POST but not PUT/DELETE.
    const obs = await t.act(`Search for "${term}" in ${label}`, async () => {
      await t.field(field).fill(term, { timeout: 5000 });
      await t.submitForm(el);
    }, { guard: "allow-post" });

    const enc = encodeURIComponent(term);
    const urlHasTerm = obs.urlAfter.includes(term) || obs.urlAfter.includes(enc);
    const callsWithTerm = apiCalls(obs).filter((n) => `${n.url} ${n.postData || ""}`.includes(term));
    const responded = urlHasTerm || callsWithTerm.length > 0 || obs.diff.dom.changed;
    const searchFailures = failedCalls(obs).filter((n) => callsWithTerm.includes(n) || n.resourceType === "document");
    const reflected = await t.page
      .evaluate((q) => document.body.innerText.toLowerCase().includes(q) || [...document.querySelectorAll("input")].some((i) => i.value === q), term)
      .catch(() => false);

    let persists = null;
    if (urlHasTerm) {
      const reload = await t.reload();
      persists = (reload.urlAfter.includes(term) || reload.urlAfter.includes(enc)) && failedCalls(reload, 500).length === 0;
    }

    await t.fresh();
    const special = await t.act(`Search for special characters ${SPECIAL}`, async () => {
      await t.field(field).fill(SPECIAL, { timeout: 5000 });
      await t.submitForm(el);
    }, { guard: "allow-post" });
    const specialBroken = jsErrors(special).length > 0 || failedCalls(special, 500).length > 0;

    return {
      primary: obs,
      persistsOnReload: persists,
      checks: [
        check("Search runs", responded && !obs.error, {
          expected: "URL, request or results change",
          actual: obs.error || (responded ? (urlHasTerm ? obs.urlAfter : listCalls(callsWithTerm) || "results changed") : "nothing happened"),
          severity: "high",
          issue: `Search in ${label} does nothing`,
        }),
        check("Search request succeeds", searchFailures.length === 0, {
          expected: "HTTP < 400",
          actual: listCalls(searchFailures),
          severity: "high",
          issue: `Search request fails (${searchFailures[0]?.status ?? "error"})`,
        }),
        ...errorChecks(obs, { what: "searching" }),
        check("Search term is shown back to the user", reflected, {
          expected: `"${term}" visible in the page or kept in the field`,
          actual: reflected ? "shown" : "not shown",
          severity: "low",
          soft: true,
        }),
        check("Search survives a reload", persists !== false, {
          expected: "term still in URL, no errors after reload",
          actual: persists === null ? "n/a (term not in URL)" : persists ? "kept" : "lost",
          severity: "medium",
          issue: "Search results are lost on reload",
        }),
        check("Special characters don't break search", !specialBroken, {
          expected: "no exception or 5xx for input with quotes and < > % &",
          actual: specialBroken ? `${listConsole(jsErrors(special))} ${listCalls(failedCalls(special, 500))}` : "handled",
          severity: "high",
          issue: "Search breaks on special characters (unescaped input)",
        }),
      ],
    };
  },
};
