import { generateJSON } from "../../llm/index.js";
import { check } from "../checks.js";

// Generic checks can see THAT something changed, not whether the result is
// right (a cart total that doesn't add up, search results unrelated to the
// query). For templates marked `judge: true`, a passing test's after-screenshot
// goes to the LLM for a plausibility verdict.
// Returns a check, or null if the LLM gave no usable answer.
export async function judgeOutcome(test, screenshot) {
  const prompt = `You are reviewing one automated web test for BugOps. The test's own checks passed
(no errors, the page changed), but they can't tell whether the RESULT is correct.

Test: ${test.name}
Element: ${test.element?.label || "page"}
What the test expects: ${JSON.stringify(test.spec)}
What happened: ${JSON.stringify(test.observed)}

The screenshot shows the page right after the action. Look for logic errors a generic check can't see:
totals, prices or counts that don't add up; search results unrelated to the search term; the wrong
item created, edited or shown; garbled or placeholder text ("undefined", "NaN", "[object Object]",
"{{name}}"); a success message that contradicts what is shown.
Only answer "incorrect" for a problem you can actually see. If it looks fine or you can't tell, say so.

Return ONLY valid JSON matching this schema exactly:
{ "verdict": "correct | incorrect | unsure", "confidence": "number 0-1", "reason": "string, one sentence" }`;

  const { parsed } = await generateJSON(prompt, [screenshot]);
  if (!parsed || !["correct", "incorrect", "unsure"].includes(parsed.verdict)) return null;
  const confidence = Math.max(0, Math.min(1, Number(parsed.confidence) || 0));
  const reason = String(parsed.reason || "").slice(0, 300);
  const wrong = parsed.verdict === "incorrect";
  return check("LLM review: result looks correct", !wrong, {
    expected: "the outcome makes sense for the action",
    actual: `${parsed.verdict} (confidence ${confidence.toFixed(2)}): ${reason}`,
    severity: "medium",
    // Only a confident "incorrect" fails the test; anything less is a warning.
    soft: !(wrong && confidence >= 0.8),
    issue: `Looks wrong after ${test.name.toLowerCase()}: ${reason}`,
  });
}
