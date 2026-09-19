import { chromium } from "playwright";
import dotenv from "dotenv";
import fs from "fs";

dotenv.config();

const TARGET_URL = process.env.TARGET_URL;
const HEADLESS = process.env.HEADLESS === "true";
const SCREENSHOT_PATH = process.env.SCREENSHOT_PATH || "artifacts/step2.png";
const CLICK_SELECTOR = process.env.CLICK_SELECTOR || "";
const INPUT_SELECTOR = process.env.INPUT_SELECTOR || "";
const INPUT_TEXT = process.env.INPUT_TEXT || "";

if (!TARGET_URL) {
  throw new Error("TARGET_URL is missing. Put it in .env");
}

const browser = await chromium.launch({
  headless: HEADLESS,
  // Uses the installed Google Chrome instead of Playwright's bundled Chromium.
  channel: "chrome",
});

const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
});

const page = await context.newPage();

try {
  console.log(`\\n[1] Opening: ${TARGET_URL}`);
  await page.goto(TARGET_URL, {
    waitUntil: "domcontentloaded",
    timeout: 60_000,
  });

  await page.waitForLoadState("networkidle").catch(() => {});

  console.log("\\n[2] PAGE INFO");
  console.log("URL:", page.url());
  console.log("Title:", await page.title());

  // Step 3: collect information that Playwright can read from the page.
  const pageInfo = await page.evaluate(() => {
    const clean = (value) => (value || "").replace(/\\s+/g, " ").trim();

    const buttons = [...document.querySelectorAll("button")].map((el, i) => ({
      index: i,
      text: clean(el.innerText || el.textContent),
      ariaLabel: el.getAttribute("aria-label"),
      type: el.getAttribute("type"),
      disabled: el.disabled,
    }));

    const inputs = [
      ...document.querySelectorAll("input, textarea, select"),
    ].map((el, i) => ({
      index: i,
      tag: el.tagName.toLowerCase(),
      type: el.getAttribute("type"),
      name: el.getAttribute("name"),
      id: el.id,
      placeholder: el.getAttribute("placeholder"),
      ariaLabel: el.getAttribute("aria-label"),
      value: el.value,
    }));

    const links = [...document.querySelectorAll("a")].map((el, i) => ({
      index: i,
      text: clean(el.innerText || el.textContent),
      href: el.href,
    }));

    return {
      url: location.href,
      title: document.title,
      buttons,
      inputs,
      links,
    };
  });

  fs.mkdirSync("artifacts", { recursive: true });
  fs.writeFileSync(
    "artifacts/page-info.json",
    JSON.stringify(pageInfo, null, 2),
  );

  console.log(`Buttons: ${pageInfo.buttons.length}`);
  console.log(`Inputs:  ${pageInfo.inputs.length}`);
  console.log(`Links:   ${pageInfo.links.length}`);
  console.log("Full page information saved to artifacts/page-info.json");

  console.log("\\n[4] BUTTONS");
  pageInfo.buttons.forEach((b) => {
    console.log(
      `[${b.index}] "${b.text}" | aria="${b.ariaLabel || ""}" | disabled=${b.disabled}`,
    );
  });

  console.log("\\n[5] INPUTS");
  pageInfo.inputs.forEach((input) => {
    console.log(
      `[${input.index}] ${input.tag} type="${input.type || ""}" ` +
        `name="${input.name || ""}" id="${input.id || ""}" ` +
        `placeholder="${input.placeholder || ""}"`,
    );
  });

  console.log("\\n[6] LINKS");
  pageInfo.links.forEach((link) => {
    console.log(`[${link.index}] "${link.text}" -> ${link.href}`);
  });

  // Step 4: click a specific button.
  // IMPORTANT: Do not blindly click every button. Some buttons can submit forms,
  // delete data, log out, purchase something, etc.
  if (CLICK_SELECTOR) {
    console.log(`\\n[7] Clicking: ${CLICK_SELECTOR}`);
    await page.locator(CLICK_SELECTOR).first().click();
    await page.waitForLoadState("networkidle").catch(() => {});
    console.log("Click completed.");
  } else {
    console.log("\\n[7] No CLICK_SELECTOR configured; skipping click.");
  }

  // Step 5: type into a specific input.
  if (INPUT_SELECTOR) {
    console.log(`\\n[8] Filling: ${INPUT_SELECTOR}`);
    await page.locator(INPUT_SELECTOR).first().fill(INPUT_TEXT);
    console.log("Input completed.");
  } else {
    console.log("\\n[8] No INPUT_SELECTOR configured; skipping input.");
  }

  // Step 6: screenshot.
  console.log(`\\n[9] Taking screenshot: ${SCREENSHOT_PATH}`);
  fs.mkdirSync("artifacts", { recursive: true });
  await page.screenshot({
    path: SCREENSHOT_PATH,
    fullPage: true,
  });

  console.log("\\nDONE.");
  console.log("Artifacts:");
  console.log("  - artifacts/page-info.json");
  console.log(`  - ${SCREENSHOT_PATH}`);
} catch (error) {
  console.error("\\nPLAYWRIGHT ERROR:");
  console.error(error);

  fs.mkdirSync("artifacts", { recursive: true });
  await page
    .screenshot({
      path: "artifacts/error.png",
      fullPage: true,
    })
    .catch(() => {});

  process.exitCode = 1;
} finally {
  await browser.close();
}
