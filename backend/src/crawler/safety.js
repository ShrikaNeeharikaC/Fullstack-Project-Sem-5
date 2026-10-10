// Keyword check for actions that could change or destroy data, end the
// session, or spend money. The LLM also flags risky actions; an action is
// treated as risky if EITHER says so, and risky actions always pause the
// crawl to ask the user before anything is clicked.
const RISKY_PATTERN =
  /\b(delete|remove|destroy|erase|clear\s*all|reset|log\s*out|logout|sign\s*out|signout|unsubscribe|deactivate|close\s*account|cancel|purchase|buy|checkout|pay|payment|order|subscribe|upgrade|confirm|transfer|withdraw|send|publish|submit|apply|book|donate)\b/i;

export function isRiskyByKeyword(candidate) {
  const haystack = [candidate.text, candidate.ariaLabel, candidate.href, candidate.name]
    .filter(Boolean)
    .join(" ");
  return RISKY_PATTERN.test(haystack);
}

// Placeholder values for form fields. Obviously fake so nothing real is
// ever submitted.
export function testValueFor(field) {
  const type = (field.type || "").toLowerCase();
  const hint = `${field.name || ""} ${field.placeholder || ""} ${field.label || ""}`.toLowerCase();

  if (field.tag === "select") return { kind: "select" };
  if (type === "checkbox" || type === "radio") return { kind: "check" };
  if (type === "email" || hint.includes("email")) return { kind: "fill", value: "bugops.test@example.com" };
  if (type === "password") return { kind: "fill", value: "BugOps-Test-123!" };
  if (type === "tel" || hint.includes("phone")) return { kind: "fill", value: "5555550123" };
  if (type === "number" || type === "range") return { kind: "fill", value: "42" };
  if (type === "url") return { kind: "fill", value: "https://example.com" };
  if (type === "date") return { kind: "fill", value: "2025-01-15" };
  if (type === "file") return { kind: "skip" };
  if (hint.includes("name")) return { kind: "fill", value: "BugOps Tester" };
  if (type === "search" || hint.includes("search")) return { kind: "fill", value: "test" };
  return { kind: "fill", value: "BugOps test input" };
}
