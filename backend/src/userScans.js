import { scans } from "./db.js";
import { bugopsFromRuns, countBugs, targetKey } from "./history.js";

// Who ran which scan. Every scan started from the website is recorded here,
// so "Recently scanned" and the dashboard only show the user's own results.

export async function recordScanStart({ userId, kind, runId, url }) {
  await scans().insertOne({
    userId,
    kind,
    runId,
    url,
    targetKey: targetKey(url),
    status: "running",
    startedAt: new Date(),
    finishedAt: null,
  });
}

// Called when a scan settles. A scan stopped early still has a report and
// counts as done; a failed one is kept as "error" and not listed.
export async function recordScanEnd(runId, { error, report } = {}) {
  await scans().updateOne(
    { runId },
    { $set: { status: error ? "error" : "done", finishedAt: new Date(), error: error || null, ...(report ? { report } : {}) } },
  );
}

export async function userOwnsRun(userId, runId) {
  return !!(await scans().findOne({ userId, runId }));
}

// The latest finished crawl and test run for one of the user's targets.
async function latestRuns(userId, key) {
  const done = { userId, targetKey: key, status: "done" };
  const [crawl, tests] = await Promise.all([
    scans().findOne({ ...done, kind: "crawl" }, { sort: { finishedAt: -1 } }),
    scans().findOne({ ...done, kind: "tests" }, { sort: { finishedAt: -1 } }),
  ]);
  return { crawl, tests };
}

// Dashboard rows for a URL the user scanned (or their most recent scan).
export async function userBugops(userId, url) {
  let key = url ? targetKey(url) : null;
  if (!key) {
    const last = await scans().findOne({ userId, status: "done" }, { sort: { finishedAt: -1 } });
    if (!last) return { url: null, lastScanned: null, rows: [] };
    key = last.targetKey;
  }
  const { crawl, tests } = await latestRuns(userId, key);
  if (!crawl && !tests) return { url: url || null, lastScanned: null, rows: [] };
  return bugopsFromRuns({
    url: (crawl && tests ? (crawl.finishedAt > tests.finishedAt ? crawl : tests) : crawl || tests).url,
    crawlId: crawl?.runId,
    testsId: tests?.runId,
  });
}

// "Recently scanned": one entry per URL the user scanned, newest first.
export async function listUserScans(userId, limit = 12) {
  const targets = await scans()
    .aggregate([
      { $match: { userId, status: "done" } },
      { $sort: { finishedAt: -1 } },
      { $group: { _id: "$targetKey", url: { $first: "$url" }, lastScanned: { $first: "$finishedAt" } } },
      { $sort: { lastScanned: -1 } },
      { $limit: limit },
    ])
    .toArray();

  return Promise.all(
    targets.map(async (t) => {
      const { crawl, tests } = await latestRuns(userId, t._id);
      const { rows } = bugopsFromRuns({ url: t.url, crawlId: crawl?.runId, testsId: tests?.runId });
      return { url: t.url, lastScanned: t.lastScanned, bugs: countBugs(rows) };
    }),
  );
}
