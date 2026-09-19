import { chromium } from "playwright";
import { takeScreenshot } from "./screenshot.js";
import { extractPageInfo } from "./pageAnalyzer.js";
import { analyzePage } from "./llm/openrouter.js";
import fs from "fs";

export async function analyzePageWorkflow(url) {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 900 },
    });
    const page = await context.newPage();

    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(2000);

    const { screenshotBuffer, screenshotPath } = await takeScreenshot(page);
    const pageInfo = await extractPageInfo(page);

    fs.mkdirSync("artifacts", { recursive: true });
    fs.writeFileSync(
      "artifacts/page-info.json",
      JSON.stringify(pageInfo, null, 2),
    );

    const geminiResult = await analyzePage(screenshotBuffer, pageInfo);

    fs.writeFileSync(
      "artifacts/analysis.json",
      JSON.stringify(geminiResult.parsed || geminiResult.output_text, null, 2),
    );

    if (!geminiResult.parsed) {
      throw new Error(
        "Failed to parse structured JSON from Gemini. Check artifacts/analysis.json for raw output.",
      );
    }

    return geminiResult.parsed;
  } finally {
    await browser.close();
  }
}
