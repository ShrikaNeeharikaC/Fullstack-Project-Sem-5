import { getLlmModel } from "../llm/index.js";
import { getCrawlLimits } from "./config.js";
import { cacheKey, fingerprintInput, getOrComputeAnalysis } from "./scanCache.js";
import { emit } from "./session.js";

const limits = getCrawlLimits();

// Scan-level control around LLM use: the call budget, the per-scan result
// cache, and what to do after a quota error. The crawl nodes call these
// instead of handling it inline.

export function canUseLlm(session) {
  return !session.llmDisabled && session.llmCalls < limits.maxLlmCalls;
}

export async function analyzeCached(session, unit, input, analyze) {
  if (!session.userId || !session.authSessionId) return analyze();
  const fingerprintStartedAt = performance.now();
  const inputHash = fingerprintInput(input);
  session.cache.fingerprintMs += performance.now() - fingerprintStartedAt;
  const key = cacheKey({
    userId: session.userId,
    sessionId: session.authSessionId,
    url: session.scanUrl,
    // promptVersion: bump when a prompt or its reply shape changes, so old
    // cached replies aren't reused.
    config: { limits, viewport: "1440x900", model: getLlmModel(), promptVersion: 2 },
    unit,
    input: inputHash,
  });
  // Calls are counted by the session's LlmUsageCounter, not here.
  const { value, hit, fallback } = await getOrComputeAnalysis(key, analyze, (result) => {
    if (unit === "landing") return !!result?.parsed;
    if (unit === "rank") return Array.isArray(result);
    if (unit === "evaluate") return !!result && typeof result.outcome === "string";
    return false;
  });
  if (hit) {
    session.cache.hits++;
    emit(session, "cache_hit", `Reused cached ${unit} analysis`);
    return value;
  }
  session.cache.misses++;
  if (fallback && process.env.SCAN_CACHE_ENABLED !== "false" && process.env.REDIS_URL) session.cache.errors++;
  return value;
}

// After a daily-quota error, stop calling the LLM for the rest of the scan
// (the crawl continues with rule-based ranking and signal-only bug reports).
export function noteLlmError(session, err) {
  if (err.code === "QUOTA_EXHAUSTED" && !session.llmDisabled) {
    session.llmDisabled = true;
    emit(session, "warning", "LLM quota exhausted: continuing without the LLM for this scan");
  }
}
