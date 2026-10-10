import crypto from "crypto";

// Everything the crawler may click. The same selector is used for extraction
// and for locating the element again, so a candidate's `domIndex` (its
// position among ALL matches, visible or not) always points at the same node
// on a freshly loaded page.

//defines the selector for clickable elements on the page, including links, buttons, and other interactive elements.
export const CLICKABLE_SELECTOR =
  'a[href], button, [role="button"], [role="tab"], [role="menuitem"], input[type="submit"], input[type="button"], summary';

// Everything the crawler may fill in. The same selector is used for extraction
export const FIELD_SELECTOR =
  'input:not([type="hidden"]):not([type="submit"]):not([type="button"]):not([type="image"]), textarea, select';

// Reads the current screen: clickable candidates and fillable forms.
//this function takes an inventory of the current page, including all clickable elements and fillable forms, and returns a structured representation of the page's interactive elements.
export async function extractCandidates(page) {
  return page.evaluate(
    ({ clickableSelector, fieldSelector }) => {
      const clean = (v) => (v || "").replace(/\s+/g, " ").trim().slice(0, 120);
      const isVisible = (el) => {
        const r = el.getBoundingClientRect();
        const s = getComputedStyle(el);
        return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
      };
      const labelFor = (el) => {
        if (el.id) {
          const l = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
          if (l) return clean(l.innerText);
        }
        const wrap = el.closest("label");
        return wrap ? clean(wrap.innerText) : "";
      };

      const allClickables = [...document.querySelectorAll(clickableSelector)];
      const clickables = [];
      allClickables.forEach((el, domIndex) => {
        if (!isVisible(el) || el.disabled) return;
        const tag = el.tagName.toLowerCase();
        const role = tag === "a" ? "link" : el.getAttribute("role") || "button";
        clickables.push({
          domIndex,
          tag,
          role,
          text: clean(el.innerText || el.value || el.textContent),
          ariaLabel: el.getAttribute("aria-label"),
          href: tag === "a" ? el.href : null,
          // Submit buttons inside a <form> are handled as part of that form.
          inForm: !!el.closest("form") && el.type === "submit",
        });
      });

      const allFields = [...document.querySelectorAll(fieldSelector)];
      const describeField = (el) => ({
        domIndex: allFields.indexOf(el),
        tag: el.tagName.toLowerCase(),
        type: el.getAttribute("type") || (el.tagName === "TEXTAREA" ? "textarea" : ""),
        name: el.getAttribute("name"),
        placeholder: el.getAttribute("placeholder"),
        label: labelFor(el) || el.getAttribute("aria-label") || "",
        required: el.required,
      });

      const forms = [];
      [...document.querySelectorAll("form")].forEach((form, formIndex) => {
        if (!isVisible(form)) return;
        const fields = [...form.querySelectorAll(fieldSelector)].filter(isVisible).map(describeField);
        if (!fields.length) return;
        const submit = form.querySelector('button[type="submit"], input[type="submit"], button:not([type])');
        forms.push({
          formIndex,
          fields,
          submitDomIndex: submit ? allClickables.indexOf(submit) : null,
          submitText: submit ? clean(submit.innerText || submit.value) : "",
          action: form.getAttribute("action"),
        });
      });

      // Inputs outside any <form> (e.g. TodoMVC's "What needs to be done?")
      // become single-field forms that "submit" by pressing Enter.
      allFields.forEach((el) => {
        if (el.closest("form") || !isVisible(el)) return;
        forms.push({
          formIndex: null,
          fields: [describeField(el)],
          submitDomIndex: null,
          submitText: "",
          action: null,
        });
      });

      return {
        url: location.href,
        title: document.title,
        clickables,
        forms,
      };
    },
    { clickableSelector: CLICKABLE_SELECTOR, fieldSelector: FIELD_SELECTOR },
  );
}

// Identifies a "screen": same URL (ignoring query string) and same set of
// interactive elements => same screen, even if the text content differs.
export function fingerprint(snapshot) {
  const u = new URL(snapshot.url);
  const structure = [
    ...snapshot.clickables.map((c) => `${c.role}:${c.text || c.ariaLabel || ""}`),
    ...snapshot.forms.map((f) => `form:${f.fields.map((x) => x.name || x.placeholder || x.type).join(",")}`),
  ].sort();
  return crypto
    .createHash("sha1")
    .update(u.origin + u.pathname + u.hash + "|" + structure.join("|"))
    .digest("hex")
    .slice(0, 12);
}

// URL normalisation used to avoid visiting the same page twice.
// The function removes unnecessary differences, such as tracking query parameters and trailing slashes.
// However, it preserves meaningful hash routes such as #/active.
// The goal is to avoid visiting the same page repeatedly.
export function normalizeUrl(href) {
  try {
    const u = new URL(href);
    u.search = "";
    if (u.hash === "#" || u.hash === "#/") u.hash = "";
    return u.toString().replace(/\/$/, "");
  } catch {
    return href;
  }
}

// Finds a candidate again on the live page. Prefers role + accessible name
// (the project's preferred locator style) and falls back to the DOM index
// when the name is missing or ambiguous.
export async function locateClickable(page, candidate) {
  const name = candidate.text || candidate.ariaLabel;
  if (name && (candidate.role === "link" || candidate.role === "button")) {
    const byRole = page.getByRole(candidate.role, { name, exact: true });
    if ((await byRole.count()) === 1) return byRole;
  }
  return page.locator(CLICKABLE_SELECTOR).nth(candidate.domIndex);
}

// The function locateClickable(page, candidate) tries two approaches:
// 1. Find by name: Look for the unique button named Login.
// 2. Find by position: If that doesn't work reliably, use the element's recorded position in the list.
// The function locateField(page, field) similarly finds a text box using its position.
// This is necessary because the program needs to locate the actual browser element before it can interact with it.
export function locateField(page, field) {
  return page.locator(FIELD_SELECTOR).nth(field.domIndex);
}
