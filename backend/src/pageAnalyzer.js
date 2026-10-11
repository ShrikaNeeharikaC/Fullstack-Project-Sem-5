import { relevantNetwork } from "./testlib/observer.js";

export async function extractPageInfo(page) {
  const pageInfo = await page.evaluate(() => {
    const clean = (val) => (val || "").replace(/\s+/g, " ").trim();

    const links = Array.from(document.querySelectorAll("a"))
      .map((el) => ({
        text: clean(el.innerText || el.textContent),
        href: el.href,
        ariaLabel: el.getAttribute("aria-label"),
      }))
      .filter((l) => l.text || l.ariaLabel);

    const buttons = Array.from(document.querySelectorAll("button")).map(
      (el) => ({
        text: clean(el.innerText || el.textContent),
        type: el.getAttribute("type"),
        ariaLabel: el.getAttribute("aria-label"),
      }),
    );

    const inputs = Array.from(
      document.querySelectorAll("input, textarea, select"),
    ).map((el) => {
      const type = el.getAttribute("type") || "";
      const value =
        type.toLowerCase() === "password" ? "[REDACTED]" : el.value || "";
      return {
        tag: el.tagName.toLowerCase(),
        type: type,
        name: el.getAttribute("name"),
        placeholder: el.getAttribute("placeholder"),
        ariaLabel: el.getAttribute("aria-label"),
        required: el.required,
        value: value,
      };
    });

    const images = Array.from(document.querySelectorAll("img")).map((el) => ({
      alt: el.getAttribute("alt"),
      src: el.src,
      width: el.width,
      height: el.height,
    }));

    const forms = Array.from(document.querySelectorAll("form")).map(
      (el, i) => ({
        index: i,
        action: el.getAttribute("action"),
        method: el.getAttribute("method"),
      }),
    );

    return {
      url: location.href,
      title: document.title,
      visibleText: document.body.innerText.substring(0, 5000),
      links,
      buttons,
      inputs,
      images,
      forms,
    };
  });

  let ariaSnapshot = null;
  try {
    if (typeof page.ariaSnapshot === "function") {
      ariaSnapshot = await page.ariaSnapshot({ mode: "ai" });
    }
  } catch (e) {
    console.warn("ariaSnapshot not available or failed:", e.message);
  }

  return { ...pageInfo, ariaSnapshot };
}

// page-info.json plus the observation layer's view of the page load:
// network calls, console errors, cookies, storage and a DOM summary.
//   observed = { network, console } from observer.since(mark)
//   state    = captureState(page) taken after the load settled
export async function extractFullPageInfo(page, { observed, state }) {
  const base = await extractPageInfo(page);
  return {
    ...base,
    network: relevantNetwork(observed.network),
    console: observed.console,
    cookies: state.cookies,
    localStorage: state.localStorage,
    sessionStorage: state.sessionStorage,
    dom: state.dom,
  };
}
