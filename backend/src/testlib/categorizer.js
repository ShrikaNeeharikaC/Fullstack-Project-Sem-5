import { generateJSON } from "../llm/index.js";
import { isDestructiveByKeyword } from "../crawler/safety.js";
import { describeElement, hasField, isFileField, isPasswordField, isTextish } from "./elements.js";

export const CATEGORIES = ["auth", "search", "create", "update", "delete", "cart", "upload", "nav", "generic"];

// Fixed output schema. The prompt shows it to the model and
// validateCategorization() enforces it, so downstream code never sees
// anything else.
export const CATEGORIZATION_SCHEMA = {
  page_type: "string, e.g. 'login page', 'product listing', 'todo app'",
  elements: [
    {
      id: "string, an element id from the list (e.g. 'e3')",
      category: CATEGORIES.join(" | "),
      priority: "integer 1-10, 10 = test first",
      destructive: "boolean",
      reason: "string, one short sentence",
    },
  ],
};

const MAX_ELEMENTS_FOR_LLM = 80;

function buildPrompt({ url, title, elements }) {
  return `You are the element-classification step of BugOps, an automated web QA tool.
You get a screenshot of a web page and the interactive elements Playwright extracted from its DOM.
Classify every element so the tool can run the right reusable test on it.

Categories (choose exactly one per element):
- auth: log in / sign up / log out / password reset forms and buttons, account or session controls
- search: search boxes, search forms, buttons that run or open search
- create: forms, inputs or buttons that add new content (new post, add todo, comment, contact form, save)
- update: edits existing content (edit, rename, update, change quantity of an existing item)
- delete: anything that removes data (delete, remove, trash, clear completed)
- cart: add to cart / bag / basket, quantity changes, view cart
- upload: file upload inputs or buttons
- nav: links, tabs or menu items that move to another page, route or section
- generic: everything else (toggles, menus, filters, accordions, carousels, cookie banners)

priority: how important the element is to test. Core user flows (auth, search, create, cart, main
navigation) are high; footer, legal and social links are low; duplicates of an already-listed
element are low.

destructive: true if activating it could delete data, end the session (log out), spend money
(buy, checkout, pay, subscribe), send something to real people, or irreversibly change account
settings. When unsure, say true.

Page URL: ${url}
Page title: ${title}

Elements:
${JSON.stringify(elements, null, 1)}

Return ONLY valid JSON matching this schema exactly, with one entry per element id and no ids
that are not in the list:
${JSON.stringify(CATEGORIZATION_SCHEMA, null, 2)}`;
}

// Enforces the schema on the LLM reply. Returns Map(id -> entry) holding only
// well-formed entries for known ids; anything malformed is dropped so the
// rule-based categorizer covers it.
export function validateCategorization(parsed, knownIds) {
  const out = new Map();
  if (!parsed || !Array.isArray(parsed.elements)) return out;
  for (const e of parsed.elements) {
    if (!e || typeof e.id !== "string" || !knownIds.has(e.id) || out.has(e.id)) continue;
    const category = String(e.category || "").toLowerCase().trim();
    if (!CATEGORIES.includes(category)) continue;
    const priority = Math.round(Number(e.priority));
    out.set(e.id, {
      category,
      priority: Number.isFinite(priority) ? Math.min(10, Math.max(1, priority)) : 5,
      destructive: e.destructive === true || e.destructive === "true",
      reason: typeof e.reason === "string" ? e.reason.slice(0, 200) : "",
    });
  }
  return out;
}

const AUTH_TEXT = /\b(log\s*in|login|sign\s*in|signin|sign\s*up|signup|register|log\s*out|logout|sign\s*out|forgot|password|account)\b/i;
const SEARCH_TEXT = /\b(search|find|query)\b/i;
const CART_TEXT = /\b(add\s*to\s*(cart|bag|basket)|cart|basket|bag)\b/i;
const DELETE_TEXT = /\b(delete|remove|trash|destroy|clear)\b|^[×✕✖x]$/i;
const UPDATE_TEXT = /\b(edit|update|rename|modify)\b|✎|✏/i;
const CREATE_TEXT = /\b(add|new|create|post|save|compose|publish|comment|send|submit|what needs to be done)\b/i;

// Keyword fallback, used when the LLM is off, fails, or skips an element.
export function categorizeByRules(el) {
  const fields = el.form?.fields || [];
  const text = [
    el.text,
    el.ariaLabel,
    el.title,
    el.className,
    ...fields.flatMap((f) => [f.name, f.placeholder, f.label, f.type]),
  ]
    .filter(Boolean)
    .join(" ");

  let category = "generic";
  if (hasField(el, isFileField)) category = "upload";
  else if (hasField(el, isPasswordField) || AUTH_TEXT.test(text)) category = "auth";
  else if (hasField(el, (f) => f.type === "search") || SEARCH_TEXT.test(text)) category = "search";
  else if (CART_TEXT.test(text)) category = "cart";
  else if (DELETE_TEXT.test(el.text || el.ariaLabel || el.title || "")) category = "delete";
  else if (UPDATE_TEXT.test(el.text || el.ariaLabel || el.title || "")) category = "update";
  // Contact/feedback forms send a message; they don't create listed content.
  else if (hasField(el, (f) => /email/i.test(`${f.type} ${f.name}`)) && hasField(el, (f) => /message|enquiry|inquiry|feedback/i.test(`${f.name} ${f.label} ${f.placeholder}`))) category = "generic";
  else if ((el.kind === "form" || el.kind === "input") && hasField(el, isTextish)) category = "create";
  else if (el.kind === "button" && CREATE_TEXT.test(text)) category = "create";
  else if (el.kind === "link") category = "nav";

  const base = { auth: 8, search: 8, create: 7, update: 6, cart: 8, upload: 6, delete: 5, nav: 5, generic: 4 }[category];
  const priority = el.landmark === "nav" ? base + 1 : el.landmark === "footer" ? base - 2 : base;
  return {
    category,
    priority: Math.min(10, Math.max(1, priority)),
    destructive: category === "delete",
    reason: "keyword rules",
  };
}

// Classifies every element. LLM first (one call per page), rules for the rest.
// The keyword safety check always applies on top of the LLM's own flag.
export async function categorizeElements({ screenshot, url, title, elements, useLlm }) {
  let llm = new Map();
  let pageType = null;
  let llmError = null;

  if (useLlm && elements.length) {
    const forPrompt = elements.slice(0, MAX_ELEMENTS_FOR_LLM).map(describeElement);
    try {
      const { parsed } = await generateJSON(buildPrompt({ url, title, elements: forPrompt }), screenshot ? [screenshot] : []);
      llm = validateCategorization(parsed, new Set(forPrompt.map((e) => e.id)));
      pageType = typeof parsed?.page_type === "string" ? parsed.page_type : null;
      if (!llm.size) llmError = "LLM reply did not match the schema";
    } catch (err) {
      llmError = err.message;
    }
  }

  const categorized = elements.map((el) => {
    const fromLlm = llm.get(el.id);
    const result = fromLlm ? { ...fromLlm, source: "llm" } : { ...categorizeByRules(el), source: "rules" };
    const keywordDestructive = isDestructiveByKeyword(el);
    return {
      ...el,
      ...result,
      destructive: result.destructive || keywordDestructive,
      destructiveReason: keywordDestructive ? "label matches a destructive keyword" : result.destructive ? result.reason : "",
    };
  });

  return { pageType, elements: categorized, llmUsed: llm.size > 0, llmError };
}
