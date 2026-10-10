export async function analyzePage(screenshotBuffer, pageData) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set");
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
  return callGemini(fullPrompt, [screenshotBuffer]);
}

// Free-tier Gemini keys allow only a few requests per minute, so space calls out.
const MIN_INTERVAL_MS = Number(process.env.LLM_MIN_INTERVAL_MS || 4000);
let lastCallAt = 0;

async function throttle() {
  const wait = lastCallAt + MIN_INTERVAL_MS - Date.now();
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
  lastCallAt = Date.now();
}

// Sends a text prompt plus optional PNG screenshots to Gemini and asks for JSON.
// Returns { output_text, parsed } — parsed is null if the reply was not valid JSON.
export async function callGemini(promptText, imageBuffers = []) {
  if (!process.env.GEMINI_API_KEY) {
    throw new Error("GEMINI_API_KEY is not set");
  }

  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash";

  const requestBody = {
    contents: [
      {
        role: "user",
        parts: [
          {
            text: promptText
          },
          ...imageBuffers.map((buffer) => ({
            inline_data: {
              mime_type: "image/png",
              data: buffer.toString("base64")
            }
          }))
        ]
      }
    ],
    generationConfig: {
      // Ask Gemini to return raw JSON instead of free-form text
      responseMimeType: "application/json"
    }
  };

  // Gemini returns 503 (overloaded) / 429 (rate limit) during demand spikes,
  // so retry those a few times with increasing delays before giving up.
  const MAX_ATTEMPTS = 4;
  let res;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    await throttle();
    res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      {
        method: "POST",
        headers: {
          "x-goog-api-key": process.env.GEMINI_API_KEY,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(requestBody)
      }
    );

    if (res.status === 429) {
      const errorText = await res.text();
      // A per-day quota won't recover in seconds, so don't bother retrying.
      if (errorText.includes("PerDay")) {
        const err = new Error(`Gemini daily quota exhausted for ${model}. Try again tomorrow or switch GEMINI_MODEL.`);
        err.code = "QUOTA_EXHAUSTED";
        throw err;
      }
      if (attempt === MAX_ATTEMPTS) {
        throw new Error(`Gemini API Error: 429 Too Many Requests - ${errorText}`);
      }
    } else if (res.status !== 503 || attempt === MAX_ATTEMPTS) {
      break;
    }
    const delayMs = 2000 * attempt;
    console.warn(`Gemini returned ${res.status}, retrying in ${delayMs / 1000}s (attempt ${attempt}/${MAX_ATTEMPTS})`);
    await new Promise((resolve) => setTimeout(resolve, delayMs));
  }

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`Gemini API Error: ${res.status} ${res.statusText} - ${errorText}`);
  }

  const data = await res.json();
  const outputText =
    data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";

  // Strip markdown code fences if present
  let cleanJson = outputText.trim();
  if (cleanJson.startsWith("```json")) {
    cleanJson = cleanJson.substring(7);
  } else if (cleanJson.startsWith("```")) {
    cleanJson = cleanJson.substring(3);
  }
  if (cleanJson.endsWith("```")) {
    cleanJson = cleanJson.substring(0, cleanJson.length - 3);
  }
  cleanJson = cleanJson.trim();

  let parsed = null;
  try {
    parsed = JSON.parse(cleanJson);
  } catch (e) {
    console.error("Failed to parse Gemini JSON:", e);
  }

  return { output_text: outputText, parsed };
}
