// Gives scans saved on disk before accounts existed (or run from the terminal)
// to a user, so they appear in that user's Recently scanned and dashboard.
//   npm run claim-scans -- you@example.com
import "dotenv/config";
import fs from "fs";
import path from "path";
import { closeDb, connectDb, scans, users } from "./db.js";
import { crawlReport, targetKey, testsBugops } from "./history.js";

const email = String(process.argv[2] || "").trim().toLowerCase();
if (!email) {
  console.error("Usage: npm run claim-scans -- <email of the account>");
  process.exit(1);
}

await connectDb();
try {
  const user = await users().findOne({ email });
  if (!user) throw new Error(`No account with email ${email}. Sign up on the website first.`);

  const list = (dir, prefix) =>
    fs.existsSync(dir) ? fs.readdirSync(dir).filter((d) => d.startsWith(prefix)) : [];
  const found = [
    ...list(path.join("artifacts", "scans"), "scan-").map((runId) => {
      const r = crawlReport(runId);
      return r && { kind: "crawl", runId, url: r.startUrl, finishedAt: r.finishedAt };
    }),
    ...list(path.join("artifacts", "tests"), "tests-").map((runId) => {
      const b = testsBugops(runId);
      return b && { kind: "tests", runId, url: b.url, finishedAt: b.finishedAt };
    }),
  ].filter(Boolean);

  let claimed = 0;
  for (const s of found) {
    if (await scans().findOne({ runId: s.runId })) continue; // already belongs to someone
    await scans().insertOne({
      userId: user._id,
      kind: s.kind,
      runId: s.runId,
      url: s.url,
      targetKey: targetKey(s.url),
      status: "done",
      startedAt: new Date(s.finishedAt),
      finishedAt: new Date(s.finishedAt),
      error: null,
    });
    console.log(`  + ${s.kind.padEnd(5)} ${s.url} (${s.runId})`);
    claimed++;
  }
  console.log(`${claimed} scan(s) given to ${user.name} <${email}>; ${found.length - claimed} already owned.`);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  await closeDb();
}
