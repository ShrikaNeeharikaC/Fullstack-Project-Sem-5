import { callGemini } from "../llm/gemini.js";

// Asks the LLM to rank this screen's candidate actions by testing value.
// Returns [{ id, priority, reason, risky, risk_reason }] or null on failure.
export async function rankActions({ screenshot, url, title, candidates, alreadyTried }) {
  const prompt = `You are the planning step of an autonomous web QA agent that explores a website to find bugs.

You are given a screenshot of the current screen and a list of candidate actions found in the DOM.
Rank the candidates by how valuable they are to test: prefer actions that reveal new pages or features,
core user flows, and elements that look broken or suspicious. Deprioritise duplicate navigation,
legal/footer links, and social media links.

Also flag any action as "risky" if performing it could change or delete data, end the session,
send messages, spend money, or otherwise have side effects a tester should approve first.

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
      "risk_reason": "string, empty if not risky"
    }
  ]
}`;

  const { parsed } = await callGemini(prompt, [screenshot]);
  return Array.isArray(parsed?.ranked) ? parsed.ranked : null;
}

// Asks the LLM to judge one action's outcome from the after-screenshot and
// the hard error signals captured by Playwright.
// Returns { outcome, summary, bugs: [...] } or null on failure.
export async function evaluateAction({ screenshot, action, result }) {
  const prompt = `You are the evaluation step of an autonomous web QA agent.

The agent just performed this action on a website:
${JSON.stringify(action, null, 2)}

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

The attached screenshot shows the page AFTER the action.

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

  const { parsed } = await callGemini(prompt, [screenshot]);
  if (!parsed || typeof parsed.outcome !== "string") return null;
  return { ...parsed, bugs: Array.isArray(parsed.bugs) ? parsed.bugs : [] };
}
