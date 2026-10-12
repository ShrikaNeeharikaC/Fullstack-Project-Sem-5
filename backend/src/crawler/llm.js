import { callGemini } from "../llm/gemini.js";

// Asks the LLM to rank this screen's candidate actions by testing value, and
// to work out this app's own logic: what each action should do if the app
// works, and realistic test data for its forms.
// Returns [{ id, priority, reason, risky, risk_reason, expect, values }] or null on failure.
export async function rankActions({ screenshot, url, title, candidates, alreadyTried, site, screensSeen }) {
  const prompt = `You are the planning step of an autonomous web QA agent that explores a website to find bugs.

You are given a screenshot of the current screen and a list of candidate actions found in the DOM.
Rank the candidates by how valuable they are to test: prefer actions that exercise this app's core
features (the things a real user comes here to do: creating, editing, organising, searching its data),
reveal new pages, or look broken or suspicious. Deprioritise duplicate navigation, legal/footer links,
and social media links.

Also flag any action as "risky" if performing it could change or delete data, end the session,
send messages, spend money, or otherwise have side effects a tester should approve first.

Work out this app's own domain logic from what you see, and for every candidate write "expect": what a
CORRECTLY working version of THIS app should visibly do right after the action, concrete enough to
check from a screenshot. Be specific to the app, e.g. "the new item 'BugOps Test Jacket' appears in the
wardrobe grid", "the outfit is shown under Monday in the planner", "the item moves to the Clean column".
Use an empty string for plain navigation where nothing beyond the page loading is expected.

For "form" candidates also give "values": realistic test inputs that fit this app's domain, keyed by
field key (f0, f1, ...). Make them clearly test data (e.g. prefix names with "BugOps Test"), make emails
end in @example.com, and omit password and file fields.

What the app is (from the landing page analysis): ${JSON.stringify(site || "unknown")}
Screens discovered so far: ${JSON.stringify(screensSeen || [])}

Current URL: ${url}
Page title: ${title}

Actions already tested elsewhere in this scan (do not prefer near-duplicates of these):
${JSON.stringify(alreadyTried.slice(-40))}

Candidate actions:
${JSON.stringify(candidates, null, 2)}

Return ONLY valid JSON matching this schema exactly, with one entry per candidate id:
{
  "ranked": [
    {
      "id": "string (a candidate id from the list)",
      "priority": "integer 1-10, 10 = test first",
      "reason": "string, one short sentence",
      "risky": "boolean",
      "risk_reason": "string, empty if not risky",
      "expect": "string, app-specific expected result, or empty",
      "values": "object, form candidates only: { field key: test value }"
    }
  ]
}`;

  const { parsed } = await callGemini(prompt, [screenshot]);
  return Array.isArray(parsed?.ranked) ? parsed.ranked : null;
}

// Asks the LLM to judge one action's outcome from the screenshots, the hard
// error signals captured by Playwright, and (when the planner wrote one) the
// app-specific behaviour the action should have produced.
// Returns { outcome, summary, bugs: [...] } or null on failure.
export async function evaluateAction({ screenshot, beforeScreenshot, action, result, site }) {
  const images = beforeScreenshot ? [beforeScreenshot, screenshot] : [screenshot];
  const expectation = action.expect
    ? `
Expected behaviour in THIS app, written by the planning step before acting:
"${action.expect}"

Check whether that actually happened. If it clearly did not (a saved item doesn't appear, a count or
total is wrong, the wrong data or page is shown, a change didn't stick), report it as a functional bug:
say what was expected and what the screenshot shows instead. If the screenshot can't show either way,
do not report a bug for it.
`
    : "";
  const prompt = `You are the evaluation step of an autonomous web QA agent.

What the app is: ${JSON.stringify(site || "unknown")}

The agent just performed this action on a website:
${JSON.stringify({ label: action.label, kind: action.kind, href: action.href }, null, 2)}
${expectation}

What Playwright observed:
${JSON.stringify(
    {
      urlBefore: result.urlBefore,
      urlAfter: result.urlAfter,
      screenChanged: result.changed,
      httpStatus: result.httpStatus,
      actionError: result.error,
      errorSignals: result.signals,
    },
    null,
    2,
  )}

${beforeScreenshot ? "The first attached screenshot shows the screen BEFORE the action, the second shows it AFTER." : "The attached screenshot shows the page AFTER the action."}

Decide whether the action worked as a user would expect. Treat console errors, uncaught JS exceptions,
HTTP 4xx/5xx responses and failed requests as strong evidence of a bug. If nothing visibly happened
after clicking something that looks interactive, that may be a bug ("dead" button/link) unless the
element clearly does nothing by design. Do not invent problems you cannot see evidence for.

Return ONLY valid JSON matching this schema exactly:
{
  "outcome": "worked | no_visible_effect | broken",
  "summary": "string, one or two sentences on what happened",
  "bugs": [
    {
      "title": "string, short",
      "severity": "high | medium | low",
      "description": "string, what is wrong and how to reproduce it",
      "rca": "string, most likely root cause",
      "suggested_fix": "string"
    }
  ]
}`;

  const { parsed } = await callGemini(prompt, images);
  if (!parsed || typeof parsed.outcome !== "string") return null;
  return { ...parsed, bugs: Array.isArray(parsed.bugs) ? parsed.bugs : [] };
}
