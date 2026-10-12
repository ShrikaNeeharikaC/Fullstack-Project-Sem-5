// Crawl limits. The crawl stops as soon as ANY of these is reached.
// Fixed defaults for now (user-selectable presets come later); each can be
// overridden from .env without touching code.
const num = (name, fallback) => {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
};

export function getCrawlLimits() {
  return {
    // Wall-clock time spent crawling. Time spent waiting for the user to
    // answer a question does NOT count.
    timeLimitMs: num("CRAWL_TIME_LIMIT_MS", 15 * 60 * 1000),
    // Clicks / link visits / form fills performed.
    maxActions: num("CRAWL_MAX_ACTIONS", 60),
    // Distinct screens (URL + DOM fingerprint) discovered.
    maxStates: num("CRAWL_MAX_STATES", 40),
    // How many actions deep from the landing page a screen may be and
    // still get explored further. Getting past a login alone takes 2-3
    // levels, so this must leave room for the app behind it.
    maxDepth: num("CRAWL_MAX_DEPTH", 6),
    // Stop when this many actions in a row discover nothing new.
    noNoveltyLimit: num("CRAWL_NO_NOVELTY_LIMIT", 12),
    // LLM requests for the whole scan. Past this, the crawler falls back to
    // rule-based ranking and signal-only bug reports instead of failing.
    maxLlmCalls: num("CRAWL_MAX_LLM_CALLS", 90),
  };
}

export const CRAWL_HEADLESS = process.env.CRAWL_HEADLESS !== "false";
