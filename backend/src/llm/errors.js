// Error raised by a strategy for a failed provider call. Decorators (e.g. retry)
// act on these fields instead of inspecting provider-specific responses.
export class LLMError extends Error {
  constructor(message, { status, code, retryable = false } = {}) {
    super(message);
    this.name = "LLMError";
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

// Turns a non-OK fetch Response into an LLMError. `isDailyQuota(text)` flags a
// 429 that won't recover in seconds, so it fails fast instead of being retried.
export async function throwForResponse(res, { name, model, isDailyQuota = () => false }) {
  const errorText = await res.text();

  if (res.status === 429) {
    if (isDailyQuota(errorText)) {
      throw new LLMError(`${name} daily quota exhausted for ${model}. Try again tomorrow or switch the model.`, {
        status: 429,
        code: "QUOTA_EXHAUSTED"
      });
    }
    throw new LLMError(`${name} API Error: 429 Too Many Requests - ${errorText}`, { status: 429, retryable: true });
  }

  throw new LLMError(`${name} API Error: ${res.status} ${res.statusText} - ${errorText}`, {
    status: res.status,
    retryable: res.status === 503
  });
}
