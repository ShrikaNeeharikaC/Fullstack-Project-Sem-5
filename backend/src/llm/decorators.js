// Decorators for LLM clients. Every client (strategy or decorator) exposes
//   { name, model, isConfigured(), generateJSON(prompt, images) }
// and a decorator wraps another client to add one behaviour, so features stack:
//   withJsonParsing(withEvents(withRetry(withThrottle(strategy))))

import { currentBus } from "../events/EventBus.js";

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Forwards everything to the wrapped client; subclasses override generateJSON.
export class LLMDecorator {
  constructor(inner) {
    this.inner = inner;
  }

  get name() {
    return this.inner.name;
  }

  get model() {
    return this.inner.model;
  }

  isConfigured() {
    return this.inner.isConfigured();
  }

  generateJSON(promptText, images = []) {
    return this.inner.generateJSON(promptText, images);
  }
}

// Spaces calls out: free-tier keys allow only a few requests per minute.
class ThrottledClient extends LLMDecorator {
  #lastCallAt = 0;

  constructor(inner, minIntervalMs) {
    super(inner);
    this.minIntervalMs = minIntervalMs;
  }

  async generateJSON(promptText, images) {
    const wait = this.#lastCallAt + this.minIntervalMs - Date.now();
    if (wait > 0) await sleep(wait);
    this.#lastCallAt = Date.now();
    return super.generateJSON(promptText, images);
  }
}

// Retries errors a strategy marks `retryable` (429 rate limit, 503 overloaded)
// with growing delays. Non-retryable errors (e.g. daily quota) pass straight through.
class RetryingClient extends LLMDecorator {
  constructor(inner, { maxAttempts = 4, baseDelayMs = 2000 } = {}) {
    super(inner);
    this.maxAttempts = maxAttempts;
    this.baseDelayMs = baseDelayMs;
  }

  async generateJSON(promptText, images) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await super.generateJSON(promptText, images);
      } catch (err) {
        if (!err.retryable || attempt >= this.maxAttempts) throw err;
        const delayMs = this.baseDelayMs * attempt;
        console.warn(`${this.name} returned ${err.status}, retrying in ${delayMs / 1000}s (attempt ${attempt}/${this.maxAttempts})`);
        await sleep(delayMs);
      }
    }
  }
}

// Adds `parsed` to the reply: strips markdown code fences and parses the JSON.
// parsed is null if the reply was not valid JSON.
class JsonParsingClient extends LLMDecorator {
  async generateJSON(promptText, images) {
    const reply = await super.generateJSON(promptText, images);
    return { ...reply, parsed: this.#parse(reply.output_text) };
  }

  #parse(outputText) {
    let clean = outputText.trim();
    if (clean.startsWith("```json")) clean = clean.substring(7);
    else if (clean.startsWith("```")) clean = clean.substring(3);
    if (clean.endsWith("```")) clean = clean.substring(0, clean.length - 3);

    try {
      return JSON.parse(clean.trim());
    } catch (e) {
      console.error(`Failed to parse ${this.name} JSON:`, e);
      return null;
    }
  }
}

// Publishes an "llm_call" event to the bus of the scan/run in progress (see
// events/EventBus.js), so usage counters can subscribe instead of every caller
// reporting its own calls. Does nothing outside a scan/run.
class EventedClient extends LLMDecorator {
  generateJSON(promptText, images) {
    currentBus()?.emit("llm_call", `${this.name} call`, { provider: this.name, model: this.model });
    return super.generateJSON(promptText, images);
  }
}

export const withEvents = (client) => new EventedClient(client);
export const withThrottle =(client, minIntervalMs) => new ThrottledClient(client, minIntervalMs);
export const withRetry = (client, options) => new RetryingClient(client, options);
export const withJsonParsing = (client) => new JsonParsingClient(client);
