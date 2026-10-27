import crypto from "crypto";
import { createClient } from "redis";

export const SCAN_CACHE_VERSION = "scan-analysis-v1";
export const FINGERPRINT_VERSION = "page-input-v1";

let client;

let connecting;

const digest = (value) => crypto.createHash("sha256").update(value).digest("hex");
export const fingerprintInput = (value) => digest(Buffer.isBuffer(value) ? value : JSON.stringify(value));

export function cacheKey({ userId, sessionId, url, config, unit, input }) {
  const normalizedUrl = new URL(url);
  normalizedUrl.hash = "";
  normalizedUrl.searchParams.sort();
  const urlHash = digest(normalizedUrl.toString());
  const configHash = digest(JSON.stringify({ config, version: SCAN_CACHE_VERSION, fingerprintVersion: FINGERPRINT_VERSION }));
  return `scan:${String(userId)}:${String(sessionId)}:${urlHash}:${configHash}:${unit}:${digest(input)}`;
}

async function redis() {
  if (process.env.SCAN_CACHE_ENABLED === "false" || !process.env.REDIS_URL) return null;
  if (client?.isReady) return client;
  if (!connecting) {
    client = createClient({ url: process.env.REDIS_URL, socket: { connectTimeout: 1500, reconnectStrategy: false } });
    client.on("error", (error) => console.warn(`Redis scan cache unavailable: ${error.message}`));
    connecting = client.connect().catch((error) => {
      console.warn(`Redis scan cache unavailable: ${error.message}`);
      client = null;
      return null;
    }).finally(() => { connecting = null; });
  }
  return connecting;
}

export async function getOrComputeAnalysis(key, compute, shouldCache = () => true) {
  const db = await redis();
  if (!db) return { value: await compute(), hit: false, fallback: true };
  const lockKey = `${key}:lock`;
  const token = crypto.randomUUID();
  let locked = false;
  let computed = false;
  let computationSucceeded = false;
  let computedValue;
  const computeOnce = async () => {
    computed = true;
    computedValue = await compute();
    computationSucceeded = true;
    return computedValue;
  };
  try {
    const cached = await db.get(key);
    if (cached) return { value: JSON.parse(cached), hit: true };
    locked = (await db.set(lockKey, token, { NX: true, EX: 90 })) === "OK";
    if (!locked) {
      for (let i = 0; i < 300; i++) {
        await new Promise((resolve) => setTimeout(resolve, 100));
        const settled = await db.get(key);
        if (settled) return { value: JSON.parse(settled), hit: true };
      }
      // Do not block the scan indefinitely if another worker holds a stale lock.
      return { value: await computeOnce(), hit: false, fallback: true };
    }
    const secondRead = await db.get(key);
    if (secondRead) return { value: JSON.parse(secondRead), hit: true };
    const value = await computeOnce();
    const ttl = Number(process.env.SCAN_CACHE_TTL_SECONDS || 86400);
    if (Number.isInteger(ttl) && ttl > 0 && value !== null && value !== undefined && shouldCache(value)) {
      await db.set(key, JSON.stringify(value), { EX: ttl });
    }
    return { value, hit: false };
  } catch (error) {
    if (computed && !computationSucceeded) throw error;
    if (computationSucceeded) {
      console.warn(`Redis scan cache write failed: ${error.message}`);
      return { value: computedValue, hit: false, fallback: true };
    }
    console.warn(`Redis scan cache coordination failed: ${error.message}`);
    return { value: await computeOnce(), hit: false, fallback: true };
  } finally {
    if (locked && db.isReady) {
      await db.eval("if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end", {
        keys: [lockKey], arguments: [token],
      }).catch(() => {});
    }
  }
}

export async function closeScanCache() {
  const db = await connecting;
  await (db || client)?.quit().catch(() => {});
  client = null;
}
