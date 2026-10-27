import { throwForResponse } from "../errors.js";

// Groq's vision models accept only a handful of images per request.
const MAX_IMAGES = Number(process.env.GROQ_MAX_IMAGES || 5);

// Strategy: Groq (OpenAI-compatible chat completions). A bare client: one
// request, no retry/throttle/parsing (those are added by decorators, see ../decorators.js).
export class GroqClient {
  name = "Groq";
  defaultMinIntervalMs = 2000;

  get model() {
    return process.env.GROQ_MODEL || "meta-llama/llama-4-scout-17b-16e-instruct";
  }

  isConfigured() {
    return !!process.env.GROQ_API_KEY;
  }

  // Returns { output_text }.
  async generateJSON(promptText, imageBuffers = []) {
    if (!this.isConfigured()) throw new Error("GROQ_API_KEY is not set");

    let images = imageBuffers;
    if (images.length > MAX_IMAGES) {
      console.warn(`Groq accepts at most ${MAX_IMAGES} images per request; dropping ${images.length - MAX_IMAGES}.`);
      images = images.slice(0, MAX_IMAGES);
    }

    const requestBody = {
      model: this.model,
      messages: [
        {
          role: "user",
          content: [
            { type: "text", text: promptText },
            ...images.map((buffer) => ({
              type: "image_url",
              image_url: { url: `data:image/png;base64,${buffer.toString("base64")}` }
            }))
          ]
        }
      ],
      // Ask Groq to return raw JSON instead of free-form text
      response_format: { type: "json_object" }
    };

    const res = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(requestBody)
    });
    if (!res.ok) {
      await throwForResponse(res, {
        name: this.name,
        model: this.model,
        isDailyQuota: (text) => /per day|tokens per day|requests per day/i.test(text)
      });
    }

    const data = await res.json();
    return { output_text: data.choices?.[0]?.message?.content || "" };
  }
}
