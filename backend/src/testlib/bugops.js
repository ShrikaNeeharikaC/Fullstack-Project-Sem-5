import { generateJSON } from "../llm/index.js";

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

function pathOf(url) {
  try {
    const u = new URL(url);
    return u.pathname + u.hash || "/";
  } catch {
    return url;
  }
}

// RCA = what the evidence shows: the failed checks (expected vs observed),
// then the network, console and DOM evidence of the main action.
function buildRca(result) {
  const failed = result.checks.filter((c) => !c.pass && !c.soft);
  const parts = failed.map((c) => `${c.name}: expected ${c.expected}, observed ${c.actual}.`);
  const o = result.observed;
  if (o) {
    parts.push(`Action: ${o.action}.`);
    if (o.network.length) parts.push(`Network: ${o.network.slice(0, 4).join("; ")}.`);
    if (o.console.length) parts.push(`Console: ${o.console.slice(0, 2).join(" | ")}.`);
    if (o.stateChange.length) parts.push(`State change: ${o.stateChange.join("; ")}.`);
    if (o.persistsOnReload === false) parts.push("The expected state did not survive a page reload.");
  }
  return parts.join(" ");
}

// One row per failed test, in the dashboard's bug shape.
export function toBugOpsRows(results, { url, templates }) {
  const detected = new Date();
  const rows = results
    .filter((r) => r.status === "fail")
    .map((r) => {
      // Title from the failed check that set the row's severity.
      const firstFailed = r.checks.find((c) => !c.pass && !c.soft && c.severity === r.severity);
      return {
        testId: r.id,
        title: firstFailed?.issue || `${r.name}: ${firstFailed?.name} failed`,
        page: pathOf(url),
        url,
        detected: detected.toISOString(),
        detectedLabel: detected.toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }),
        severity: r.severity,
        status: "open",
        category: r.category,
        template: r.template,
        element: r.element?.label || "page",
        rca: buildRca(r),
        fix: templates.get(r.template)?.fixHint || "",
        fixSource: "template",
        evidence: {
          failedChecks: r.checks.filter((c) => !c.pass && !c.soft).map(({ name, expected, actual }) => ({ name, expected, actual })),
          screenshot: r.evidence.steps.at(-1)?.screenshot || null,
        },
      };
    });
  rows.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  rows.forEach((row, i) => (row.id = i + 1));
  return rows;
}

// Replaces each template fix hint with an LLM suggestion based on that bug's
// evidence. One call for all rows; on any failure the template hints stay.
export async function addLlmFixes(rows) {
  if (!rows.length) return { used: false };
  const issues = rows.slice(0, 40).map((r) => ({ id: r.id, title: r.title, page: r.page, element: r.element, rca: r.rca.slice(0, 900) }));
  const prompt = `You are the fix-suggestion step of BugOps, an automated web QA tool.
For each issue below, an automated test failed on a real web page. The "rca" field is the evidence
the test collected (network calls, console errors, DOM and storage changes).

Suggest a concrete fix a web developer could apply, in 1-3 sentences. Base it only on the evidence;
if the evidence is thin, say what to inspect first. Do not repeat the issue title.

Issues:
${JSON.stringify(issues, null, 1)}

Return ONLY valid JSON matching this schema exactly, one entry per issue id:
{ "fixes": [ { "id": "integer (issue id)", "fix": "string" } ] }`;

  try {
    const { parsed } = await generateJSON(prompt);
    const fixes = Array.isArray(parsed?.fixes) ? parsed.fixes : [];
    let applied = 0;
    for (const f of fixes) {
      const row = rows.find((r) => r.id === Number(f?.id));
      if (row && typeof f.fix === "string" && f.fix.trim()) {
        row.fix = f.fix.trim().slice(0, 600);
        row.fixSource = "llm";
        applied++;
      }
    }
    return { used: applied > 0 };
  } catch (err) {
    return { used: false, error: err.message };
  }
}
