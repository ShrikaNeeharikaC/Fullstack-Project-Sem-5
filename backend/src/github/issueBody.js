import crypto from "crypto";

// Builds the GitHub issue (title, Markdown body, labels) from gatherEvidence().
// Sections are labelled Confirmed (recorded during the scan), Suspected (AI
// analysis) or Not identified, and are left out when nothing was recorded.

const MAX_BODY = 60000;
const SEVERITY_LABEL = { high: "High", medium: "Medium", low: "Low" };

// Text from the scanned site and the LLM is untrusted: don't ping @users or
// teams, and keep it from breaking out of code blocks.
const plain = (text) => String(text ?? "").replace(/@(?=[A-Za-z0-9])/g, "@​").trim();
const codeBlock = (lines) => ["```text", ...lines.map((l) => plain(l).replace(/```/g, "'''")), "```"].join("\n");

// Hidden marker identifying this user's bug without revealing the user id.
export function issueMarker(userId, bugKey) {
  const id = crypto.createHash("sha256").update(`${userId}:${bugKey}`).digest("hex").slice(0, 24);
  return `<!-- bugops-bug:${id} -->`;
}

const CONFIDENCE = {
  high: "High: a stack trace mapped through the site's source map",
  medium: "Medium: a stack trace pointing at the served file (no source map)",
  low: "Low: correlated from the evidence, not from a stack trace",
};

// location: result of locateSource(), or null when it couldn't run.
function sourceSection(location) {
  if (!location) return "**Not identified.** No GitHub repository code was available to search.";
  const version = location.commit
    ? `\n\n_Code version: commit \`${location.commit.slice(0, 7)}\`${location.ref ? ` (${plain(location.ref)})` : ""}._`
    : "";
  if (location.status === "unidentified") return `**Not identified.** ${plain(location.sourceReason)}${version}`;
  const lead = location.status === "identified" ? "**Likely location**" : "**Suspected location (not confirmed)**";
  return [
    `${lead}: \`${location.sourceFile}\`, line ${location.sourceLine}${location.sourceFunction ? ` (in \`${plain(location.sourceFunction)}\`)` : ""}`,
    "",
    `**Source code:** [${location.sourceFile}#L${location.sourceLine}](${location.sourceCodeUrl})`,
    "",
    `**Confidence:** ${CONFIDENCE[location.sourceConfidence] || plain(location.sourceConfidence)}`,
    "",
    `**Reason:** ${plain(location.sourceReason)}`,
  ].join("\n") + version;
}

// screenshot: { imageUrl } when uploaded to the repository, else { note, dashboardUrl }.
function screenshotSection(ev, screenshot) {
  if (!ev.screenshot) return "No screenshot was recorded for this bug.";
  if (screenshot?.imageUrl) {
    return (
      `![Screenshot of the page when the bug happened](${screenshot.imageUrl})\n\n` +
      `_Captured by BugOps during the failing step (run \`${ev.runId}\`). Stored on this repository's ` +
      "`bugops-screenshots` branch, so it is visible to whoever can see the repository._"
    );
  }
  return [
    `Captured as \`${ev.screenshot}\` in BugOps run \`${ev.runId}\` but not embedded here: ${plain(screenshot?.note || "screenshot upload is turned off")}.`,
    screenshot?.dashboardUrl && `\n[Open this bug in BugOps](${screenshot.dashboardUrl}) to see it (login required).`,
  ]
    .filter(Boolean)
    .join("\n");
}

export function buildIssue(ev, { marker, location = null, screenshot = null }) {
  const severity = SEVERITY_LABEL[ev.severity] || "Low";
  const title = `[BugOps][${severity.toUpperCase()}] ${plain(ev.title)}`.slice(0, 250);
  const sections = [];
  const add = (heading, body) => body && sections.push(`## ${heading}\n\n${body}`);

  sections.push(
    "> Reported by **BugOps**, an automated web QA tool. Each section says whether it is **confirmed** " +
      "(recorded during the scan) or **suspected** (AI analysis that has not been verified).",
  );

  add(
    "Summary",
    `${plain(ev.summary)}${ev.summaryBasis ? `\n\n_Source: ${ev.summaryBasis}._` : ""}\n\n` +
      [
        "| | |",
        "|---|---|",
        `| **Severity** | ${severity} |`,
        `| **Affected page** | ${plain(ev.pageUrl)} |`,
        `| **Found by** | ${plain(ev.foundBy)} |`,
        ev.detected && `| **Detected** | ${new Date(ev.detected).toUTCString()} |`,
        ev.runId && `| **BugOps run** | \`${ev.runId}\` |`,
      ]
        .filter(Boolean)
        .join("\n"),
  );

  const errorParts = [];
  if (ev.failedChecks.length) {
    errorParts.push(
      ev.failedChecks
        .map((c) => `- **${plain(c.name)}**\n  - Expected: ${plain(c.expected)}\n  - Observed: ${plain(c.actual)}`)
        .join("\n"),
    );
  }
  if (ev.errors.length) errorParts.push(`Browser and network errors recorded:\n\n${codeBlock(ev.errors)}`);
  if (ev.stacks?.length) {
    errorParts.push(`Stack traces captured in the browser:\n\n${codeBlock(ev.stacks.flatMap((s) => [s.message, ...String(s.stack).split("\n"), ""]))}`);
  }

  add("Expected behavior", ev.expected && `${plain(ev.expected.text)}\n\n_Basis: ${ev.expected.basis}._`);

  add(
    "Actual behavior (confirmed)",
    [
      ...ev.actual.map((a) => `- ${plain(a)}`),
      ...ev.failedChecks.map((c) => `- ${plain(c.name)}: ${plain(c.actual)}`),
    ].join("\n"),
  );

  add(
    "Steps to reproduce (confirmed: the actions the testing agent took)",
    ev.steps.map((s, i) => `${i + 1}. ${plain(s)}`).join("\n"),
  );

  add("Error message and stack trace (confirmed)", errorParts.join("\n\n"));

  add("Likely source-code location", sourceSection(location));

  add(
    "Likely root cause",
    ev.rootCause
      ? `**Suspected (AI analysis, not verified):** ${plain(ev.rootCause)}`
      : "**Unknown.** BugOps recorded what went wrong but not why; see the error details above.",
  );

  add("Screenshot evidence", screenshotSection(ev, screenshot));

  add(
    "Suggested fix (not a confirmed finding)",
    ev.fix && `${plain(ev.fix)}\n\n_Basis: ${ev.fixBasis}. Verify against the code before applying._`,
  );

  let body = `${sections.join("\n\n")}\n\n${marker}\n`;
  if (body.length > MAX_BODY) body = `${body.slice(0, MAX_BODY - marker.length - 40)}\n\n_(truncated)_\n\n${marker}\n`;

  return { title, body, labels: ["bugops", `severity:${ev.severity in SEVERITY_LABEL ? ev.severity : "low"}`] };
}
