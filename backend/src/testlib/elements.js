import { CLICKABLE_SELECTOR, FIELD_SELECTOR, extractCandidates } from "../crawler/dom.js";
import { isSameSite } from "./observer.js";

// Turns the crawler's DOM snapshot into one flat list of testable elements,
// each with a stable id ("e0", "e1", ...) that the LLM refers back to.
//   kind: link | button | toggle | input | form
export async function extractElements(page) {
  const snapshot = await extractCandidates(page);
  const elements = [];
  const seenHrefs = new Set();
  const add = (el) => elements.push({ id: `e${elements.length}`, ...el });

  for (const c of snapshot.clickables) {
    if (c.inForm) continue;
    let href = null;
    try {
      href = c.href ? new URL(c.href) : null;
    } catch {}
    const scriptLink = !!href && (href.protocol === "javascript:" || c.href.endsWith("#"));
    const isLink = !!href && !scriptLink;
    if (isLink) {
      if (href.protocol !== "http:" && href.protocol !== "https:") continue; // mailto:, tel:
      if (seenHrefs.has(href.href)) continue;
      seenHrefs.add(href.href);
    }
    add({
      kind: isLink ? "link" : "button",
      text: c.text,
      ariaLabel: c.ariaLabel,
      title: c.title,
      className: c.className,
      href: isLink ? href.href : null,
      target: c.target,
      landmark: c.landmark,
      raw: c,
    });
  }

  for (const form of snapshot.forms) {
    const only = form.fields[0];
    const single = form.formIndex === null;
    const kind = single ? (only.type === "checkbox" || only.type === "radio" ? "toggle" : "input") : "form";
    add({
      kind,
      text: single ? only.label || only.placeholder || only.name || only.type : form.submitText,
      ariaLabel: null,
      href: null,
      form: { ...form, submitDomIndex: form.submitDomIndex >= 0 ? form.submitDomIndex : null },
    });
  }

  // Controls the standard selectors miss.
  const extra = await extractNonStandard(page).catch(() => ({ nonStandard: [], hiddenFiles: [], shadow: [] }));
  for (const n of extra.nonStandard) {
    add({ kind: "button", text: n.text, ariaLabel: null, href: null, css: n.css, where: "non-standard", tag: n.tag, role: n.role, tabindex: n.tabindex });
  }
  for (const f of extra.hiddenFiles) {
    add({ kind: "input", text: f.label || f.name || "file upload", href: null, where: "hidden-file-input", form: singleField(f) });
  }
  for (const s of extra.shadow) {
    if (s.isField) {
      const f = { tag: s.tag, type: s.type, name: s.name, placeholder: s.placeholder, label: s.text, required: false, css: s.host, inner: s.inner };
      add({ kind: "input", text: s.text || s.placeholder || s.name, href: null, where: "shadow-dom", form: singleField(f) });
    } else {
      add({ kind: s.href ? "link" : "button", text: s.text, ariaLabel: null, href: s.href, css: s.host, inner: s.inner, where: "shadow-dom" });
    }
  }

  // Same-site iframes: same extraction, located through the frame later.
  for (const frame of page.frames().slice(1)) {
    const frameUrl = frame.url();
    if (!isSameSite(frameUrl, page.url())) continue;
    const snap = await extractCandidates(frame).catch(() => null);
    if (!snap) continue;
    for (const c of snap.clickables) {
      if (c.inForm) continue;
      add({ kind: c.href ? "link" : "button", text: c.text, ariaLabel: c.ariaLabel, href: c.href, target: c.target, raw: c, frameUrl, where: "iframe" });
    }
    for (const form of snap.forms) {
      const fields = form.fields.map((f) => ({ ...f, frameUrl }));
      add({
        kind: form.formIndex === null ? "input" : "form",
        text: form.submitText || fields[0].label || fields[0].placeholder,
        href: null,
        frameUrl,
        where: "iframe",
        form: { ...form, fields, submitDomIndex: form.submitDomIndex >= 0 ? form.submitDomIndex : null },
      });
    }
  }

  return { url: snapshot.url, title: snapshot.title, elements };
}

const singleField = (f) => ({ formIndex: null, fields: [f], submitDomIndex: null, submitText: "", action: null });

function extractNonStandard(page) {
  return page.evaluate(
    ({ clickableSelector, fieldSelector }) => {
      const clean = (v) => (v || "").replace(/\s+/g, " ").trim().slice(0, 120);
      const visible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
      };
      // tag:nth-of-type chain up to <body> (or the top of a shadow root).
      const cssPath = (el) => {
        const parts = [];
        for (let n = el; n && n.nodeType === 1; n = n.parentElement) {
          if (n === document.body) {
            parts.unshift("body");
            break;
          }
          const tag = n.tagName.toLowerCase();
          const same = n.parentElement ? [...n.parentElement.children].filter((c) => c.tagName === n.tagName) : [n];
          parts.unshift(same.length > 1 ? `${tag}:nth-of-type(${same.indexOf(n) + 1})` : tag);
        }
        return parts.join(" > ");
      };

      // <div onclick>, <span> with cursor:pointer, ... that aren't real controls.
      const nonStandard = [];
      for (const el of document.querySelectorAll("div, span, li, img, td, i, svg, p, section, article")) {
        if (nonStandard.length >= 15) break;
        if (el.matches(clickableSelector) || el.closest(clickableSelector) || el.closest("label") || !visible(el)) continue;
        if (el.querySelector(clickableSelector)) continue; // a wrapper around real controls
        const pointer =
          getComputedStyle(el).cursor === "pointer" && (!el.parentElement || getComputedStyle(el.parentElement).cursor !== "pointer");
        if (!el.hasAttribute("onclick") && !pointer) continue;
        const text = clean(el.innerText || el.getAttribute("aria-label") || el.getAttribute("title") || el.getAttribute("alt"));
        if (text.length > 80) continue;
        nonStandard.push({ text, css: cssPath(el), tag: el.tagName.toLowerCase(), role: el.getAttribute("role"), tabindex: el.getAttribute("tabindex") });
      }

      // File inputs hidden behind a styled button/label still accept files.
      const allFields = [...document.querySelectorAll(fieldSelector)];
      const hiddenFiles = allFields
        .filter((el) => el.type === "file" && !visible(el))
        .map((el) => ({
          domIndex: allFields.indexOf(el),
          tag: "input",
          type: "file",
          name: el.getAttribute("name"),
          placeholder: null,
          label: clean(el.closest("label")?.innerText || (el.id && document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.innerText) || el.getAttribute("aria-label")),
          required: el.required,
        }));

      // Controls inside open shadow roots (web components).
      const shadow = [];
      for (const host of document.querySelectorAll("*")) {
        if (!host.shadowRoot || shadow.length >= 20) continue;
        for (const el of host.shadowRoot.querySelectorAll(`${clickableSelector}, ${fieldSelector}`)) {
          if (!visible(el)) continue;
          const isField = el.matches(fieldSelector);
          shadow.push({
            host: cssPath(host),
            inner: cssPath(el),
            tag: el.tagName.toLowerCase(),
            isField,
            type: el.getAttribute("type") || "",
            name: el.getAttribute("name"),
            placeholder: el.getAttribute("placeholder"),
            text: clean(isField ? el.getAttribute("aria-label") : el.innerText || el.getAttribute("aria-label")),
            href: el.tagName === "A" ? el.href : null,
          });
        }
      }
      return { nonStandard, hiddenFiles, shadow };
    },
    { clickableSelector: CLICKABLE_SELECTOR, fieldSelector: FIELD_SELECTOR },
  );
}

// Identity used to tell "new" elements from ones already on the page.
export const elementSignature = (el) =>
  [el.kind, el.text || el.ariaLabel || "", el.href || "", (el.form?.fields || []).map((f) => f.name || f.placeholder || f.type).join(",")].join("|");

export function elementLabel(el) {
  if (!el) return "page";
  if (el.kind === "form") {
    const names = el.form.fields.map((f) => f.label || f.placeholder || f.name || f.type).join(", ");
    return `form [${names}]${el.form.submitText ? ` → "${el.form.submitText}"` : ""}`;
  }
  const fieldName = el.form?.fields[0] && (el.form.fields[0].name || el.form.fields[0].type);
  const unnamed = el.className ? `.${el.className.split(" ")[0]}` : fieldName ? `[${fieldName}]` : `#${el.id}`;
  return `${el.kind} "${el.text || el.ariaLabel || el.title || el.href || unnamed}"${el.where ? ` (${el.where})` : ""}`;
}

// Compact description for the LLM prompt and the report (no live handles).
export function describeElement(el) {
  const out = { id: el.id, kind: el.kind, text: el.text || el.ariaLabel || el.title || "" };
  if (el.href) out.href = el.href;
  if (el.landmark) out.landmark = el.landmark;
  if (el.where) out.where = el.where;
  if (el.via?.length) out.appearsAfterClicking = el.via.map((v) => v.text || v.ariaLabel || v.id);
  if (el.form) {
    out.fields = el.form.fields.map((f) => ({
      type: f.type || f.tag,
      name: f.name,
      placeholder: f.placeholder,
      label: f.label,
      required: f.required,
    }));
    if (el.form.submitText) out.submit = el.form.submitText;
  }
  return out;
}

export const hasField = (el, pred) => !!el.form?.fields.some(pred);
export const isPasswordField = (f) => (f.type || "").toLowerCase() === "password";
export const isFileField = (f) => (f.type || "").toLowerCase() === "file";
export const isTextish = (f) =>
  f.tag !== "select" &&
  !["checkbox", "radio", "file", "submit", "button", "hidden", "range", "color", "image"].includes((f.type || "").toLowerCase());
