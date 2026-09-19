export async function analyzePage(screenshotBuffer, pageData) {
  if (!process.env.OPENROUTER_API_KEY) {
    throw new Error("OPENROUTER_API_KEY is not set");
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

  const base64Image = screenshotBuffer.toString("base64");
  const fullPrompt = prompt + "\n\nPlaywright Page Data: " + JSON.stringify(pageData, null, 2);

  const requestBody = {
    model: "openrouter/free",
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: fullPrompt
          },
          {
            type: "image_url",
            image_url: {
              url: `data:image/png;base64,${base64Image}`
            }
          }
        ]
      }
    ]
  };

  const res = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${process.env.OPENROUTER_API_KEY}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestBody)
  });

  if (!res.ok) {
    const errorText = await res.text();
    throw new Error(`OpenRouter API Error: ${res.status} ${res.statusText} - ${errorText}`);
  }

  const data = await res.json();
  const outputText = data.choices?.[0]?.message?.content || "";

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
    console.error("Failed to parse OpenRouter JSON:", e);
  }

  return { output_text: outputText, parsed };
}
