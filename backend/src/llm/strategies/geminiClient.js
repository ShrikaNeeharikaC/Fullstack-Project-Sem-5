import { throwForResponse } from "../errors.js";

// Strategy: Google Gemini. A bare client: one request, no retry/throttle/parsing
// (those are added by decorators, see ../decorators.js).
export class GeminiClient {
  name = "Gemini";
  defaultMinIntervalMs = 4000;

  get model() {
    return process.env.GEMINI_MODEL || "gemini-2.5-flash";
  }

  isConfigured() {
    return !!process.env.GEMINI_API_KEY;
  }

  // Returns { output_text }.
  async generateJSON(promptText, imageBuffers = []) {
    if (!this.isConfigured()) throw new Error("GEMINI_API_KEY is not set");

    const requestBody = {
      contents: [
        {
          role: "user",
          parts: [
            { text: promptText },
            ...imageBuffers.map((buffer) => ({
              inline_data: { mime_type: "image/png", data: buffer.toString("base64") }
            }))
          ]
        }
      ],
      // Ask Gemini to return raw JSON instead of free-form text
      generationConfig: { responseMimeType: "application/json" }
    };

    const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${this.model}:generateContent`, {
      method: "POST",
      headers: {
        "x-goog-api-key": process.env.GEMINI_API_KEY,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });
    if (!res.ok) {
      await throwForResponse(res, { name: this.name, model: this.model, isDailyQuota: (text) => text.includes("PerDay") });
    }

    const data = await res.json();
    const outputText = data.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    return { output_text: outputText };
  }
}
