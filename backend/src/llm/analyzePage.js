import { generateJSON, isLlmConfigured } from "./index.js";

export async function analyzePage(screenshotBuffer, pageData) {
  if (!isLlmConfigured()) {
    throw new Error("LLM API key is not set (see LLM_PROVIDER in .env)");
  }

  const prompt = `You are a webpage analysis engine for an autonomous web QA/testing system.

Analyze the supplied webpage screenshot together with the structured information extracted from Playwright.

Your job is to understand what is actually present on the webpage.
Do not invent elements that are not present.

Analyze:
1. Overall purpose of the page
2. Page title
3. Main sections
4. Navigation
5. Important visible text
6. Buttons
7. Input fields
8. Forms
9. Links
10. Images
11. Interactive elements
12. Possible user actions
13. UI/UX issues
14. Accessibility issues
15. Important observations about the page layout

Use the screenshot for visual understanding.
Use the Playwright data for exact structural information.
If screenshot and DOM information disagree, explicitly mention the discrepancy rather than inventing an answer.
If something cannot be determined, say so.

Return ONLY valid JSON matching this schema exactly:
{
    "page": {
        "url": "string",
        "title": "string",
        "purpose": "string"
    },
    "layout": {
        "sections": ["string"],
        "navigation": ["string"]
    },
    "content": {
        "important_text": ["string"]
    },
    "elements": {
        "buttons": ["string"],
        "inputs": ["string"],
        "forms": ["string"],
        "links": ["string"],
        "images": ["string"],
        "interactive_elements": ["string"]
    },
    "possible_actions": ["string"],
    "potential_issues": {
        "ui_ux": ["string"],
        "accessibility": ["string"]
    },
    "observations": ["string"]
}`;

  const fullPrompt = prompt + "\n\nPlaywright Page Data: " + JSON.stringify(pageData, null, 2);
  return generateJSON(fullPrompt, [screenshotBuffer]);
}
