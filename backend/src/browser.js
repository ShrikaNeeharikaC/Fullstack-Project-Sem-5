import { chromium } from "playwright";
import { takeScreenshot } from "./screenshot.js";
import { extractFullPageInfo } from "./pageAnalyzer.js";
import { attachObserver, captureState } from "./testlib/observer.js";
import { analyzePage } from "./llm/gemini.js";
import { installPublicNetworkGuard } from "./urlSafety.js";
import fs from "fs";

export async function analyzePageWorkflow(url) {
  const browser = await chromium.launch();//launches Playwright's bundled Chromium in headless mode by default.
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    await installPublicNetworkGuard(context);
    const page = await context.newPage();
    // Records network calls, console errors, cookies and storage during the load.
    const observer = await attachObserver(page, { origin: new URL(url).origin });
    const mark = observer.mark();

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });//goes to the requested url
    await page.waitForTimeout(2000);

    const { screenshotBuffer, screenshotPath } = await takeScreenshot(page);//takes the ss
    const state = await captureState(page);
    const pageInfo = await extractFullPageInfo(page, { observed: observer.since(mark), state });//reads the page info

    fs.mkdirSync("artifacts", { recursive: true });
    fs.writeFileSync(
      "artifacts/page-info.json",
      JSON.stringify(pageInfo, null, 2),
    );//saves the results to a file 

    // The LLM only needs the structure; network/storage details stay in the file.
    const { network, console: consoleLog, cookies, localStorage, sessionStorage, dom, ...llmPageInfo } = pageInfo;
    const llmResult = await analyzePage(screenshotBuffer, llmPageInfo);//send the ss and page info to the ai

    fs.writeFileSync(
      "artifacts/analysis.json",
      JSON.stringify(llmResult.parsed || llmResult.output_text, null, 2),
    );//saves the ai's answer

    if (!llmResult.parsed) {
      throw new Error(
        "Failed to parse structured JSON from the LLM. Check artifacts/analysis.json for raw output.",
      );
    }

    return llmResult.parsed;
  } finally {
    await browser.close();
  }
}
