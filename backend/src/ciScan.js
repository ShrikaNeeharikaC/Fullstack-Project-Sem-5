import dns from "node:dns/promises";
import net from "node:net";
import crypto from "node:crypto";
import { targetKey } from "./history.js";

const ipv4Private = (ip) => {
  const n = ip.split(".").map(Number);
  return n[0] === 0 || n[0] === 10 || n[0] === 127 || n[0] >= 224 ||
    (n[0] === 169 && n[1] === 254) || (n[0] === 172 && n[1] >= 16 && n[1] <= 31) ||
    (n[0] === 192 && n[1] === 168) || (n[0] === 100 && n[1] >= 64 && n[1] <= 127) ||
    (n[0] === 192 && n[1] === 0) || (n[0] === 198 && [18, 19].includes(n[1]));
};

export function isPublicAddress(address) {
  const version = net.isIP(address);
  if (version === 4) return !ipv4Private(address);
  if (version !== 6) return false;
  const ip = address.toLowerCase().split("%")[0];
  if (ip.startsWith("::ffff:")) {
    const mapped = ip.slice(7);
    if (net.isIP(mapped) === 4) return !ipv4Private(mapped);
    return false;
  }
  // Only globally routed unicast (2000::/3) is accepted. This excludes
  // loopback, unique-local, link-local, multicast, transition and reserved ranges.
  return /^[23][0-9a-f]{3}:/.test(ip);
}

export function matchesCiApiKey(authorization, configured) {
  if (!configured || typeof authorization !== "string") return false;
  const match = /^Bearer (\S+)$/.exec(authorization);
  if (!match) return false;
  const a = Buffer.from(match[1]);
  const b = Buffer.from(configured);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export async function validatePublicHttpUrl(value) {
  if (typeof value !== "string" || !value.trim()) return "A target URL is required";
  let url;
  try { url = new URL(value); } catch { return "Invalid target URL"; }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password) return "Only credential-free HTTP(S) URLs are allowed";
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".internal") || (net.isIP(hostname) === 0 && !hostname.includes("."))) return "Internal target URLs are not allowed";
  if (net.isIP(hostname)) return isPublicAddress(hostname) ? null : "Internal target URLs are not allowed";
  try {
    const addresses = await dns.lookup(hostname, { all: true, verbatim: true });
    if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) return "Internal target URLs are not allowed";
  } catch { return "Target hostname could not be resolved"; }
  return null;
}

export function bugFingerprint(bug) {
  return crypto.createHash("sha256").update([
    String(bug.title || "").trim().toLowerCase().replace(/\s+/g, " "),
    String(bug.url || bug.page || "/").replace(/[?#].*$/, "").toLowerCase(),
  ].join("|"), "utf8").digest("hex");
}

export function ciResult({ runId, status, report, baselineReports = [] }) {
  const bugs = Array.isArray(report?.bugs) ? report.bugs : [];
  const baseline = new Set(baselineReports.flatMap((item) => (item?.bugs || []).filter((b) => b.severity === "high").map(bugFingerprint)));
  const newHigh = bugs.filter((bug) => bug.severity === "high" && !baseline.has(bugFingerprint(bug)));
  const complete = status === "done" && report && Array.isArray(report.bugs);
  return {
    runId,
    scanStatus: complete ? "completed" : status === "error" ? "failed" : "incomplete",
    totalBugsFound: bugs.length,
    newlyDiscoveredHighSeverityBugs: newHigh,
    baselineExists: baselineReports.length > 0,
    ciStatus: complete && newHigh.length === 0 ? "pass" : "fail",
  };
}

export async function launchCiScan({ targetUrl, startScan, scanCollection }) {
  const urlError = await validatePublicHttpUrl(targetUrl);
  if (urlError) throw Object.assign(new Error(urlError), { statusCode: 400 });
  const target = targetKey(targetUrl);
  const previous = await scanCollection.find({ kind: { $in: ["ci", "crawl"] }, targetKey: target, status: "done" }).sort({ finishedAt: -1 }).limit(20).toArray();
  const baselineReports = previous.map((item) => item.report).filter(Boolean);
  const scan = startScan(targetUrl, {
    ciMode: true,
    askUser: async () => "skip",
    onEvent: (event) => console.log(`[${scan.scanId}] ${event.type}: ${event.message}`),
  });
  scan.ci = true;
  scan.baselineReports = baselineReports;
  await scanCollection.insertOne({ kind: "ci", runId: scan.scanId, url: targetUrl, targetKey: target, status: "running", startedAt: new Date(), finishedAt: null });
  scan.done
    .then(async (report) => {
      scan.ciSummary = ciResult({ runId: scan.scanId, status: scan.status, report, baselineReports });
      await scanCollection.updateOne({ runId: scan.scanId }, { $set: { status: "done", report, finishedAt: new Date(), ciSummary: scan.ciSummary } });
    })
    .catch(async (err) => {
      scan.ciSummary = ciResult({ runId: scan.scanId, status: "error", report: null, baselineReports });
      await scanCollection.updateOne({ runId: scan.scanId }, { $set: { status: "error", error: err.message, finishedAt: new Date(), ciSummary: scan.ciSummary } });
    });
  return scan;
}

