import fs from "fs";

export async function takeScreenshot(page) {
  fs.mkdirSync("artifacts", { recursive: true });
  const screenshotPath = "artifacts/screenshot.png";
  const screenshotBuffer = await page.screenshot({
    path: screenshotPath,
    fullPage: true,
    type: "png",
  });
  return { screenshotBuffer, screenshotPath };
}
