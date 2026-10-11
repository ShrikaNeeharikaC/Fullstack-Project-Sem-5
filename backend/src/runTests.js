// Terminal runner for the reusable test library.
//   npm run tests -- <url> [<url> ...] [--allow-mutations] [--no-llm] [--headed] [--max=N] [--search=term]
//                     [--pages=N] [--browsers=firefox,webkit]
// Stateful tests (create/delete/cart) only run with --allow-mutations; the
// login test only runs when TEST_USERNAME / TEST_PASSWORD are set in .env.
import "dotenv/config";
import { runSite } from "./testlib/runner.js";

const args = process.argv.slice(2);
const urls = args.filter((a) => !a.startsWith("--"));
const flag = (name) => args.includes(`--${name}`);
const value = (name) => args.find((a) => a.startsWith(`--${name}=`))?.split("=").slice(1).join("=");

if (!urls.length) {
  console.error("Usage: npm run tests -- <url> [--allow-mutations] [--no-llm] [--headed] [--max=N] [--search=term] [--pages=N] [--browsers=firefox,webkit]");
  process.exit(1);
}

const opts = {
  onEvent: (e) => console.log(`[${e.type}] ${e.message}`),
};
if (flag("allow-mutations")) opts.allowMutations = true;
if (flag("no-llm")) opts.useLlm = false;
if (flag("headed")) opts.headless = false;
if (value("max")) opts.maxElementTests = Number(value("max"));
if (value("search")) opts.searchTerm = value("search");
if (value("pages")) opts.maxPages = Number(value("pages"));
if (value("browsers")) opts.browsers = value("browsers").split(",").filter(Boolean);

for (const url of urls) {
  try {
    const result = await runSite(url, opts);
    const s = result.summary;
    const what = result.pages ? `${result.pages.length} pages` : result.pageType || "page type unknown";
    console.log(`\n=== ${result.url} (${what}) ===`);
    console.log(`Tests: ${s.total} | pass ${s.pass} | fail ${s.fail} | skipped ${s.skipped} | error ${s.error}`);
    console.log(`Failures: high ${s.bySeverity.high}, medium ${s.bySeverity.medium}, low ${s.bySeverity.low}`);
    for (const row of result.bugops) console.log(`  [${row.severity}] ${row.title}`);
    console.log(`\nTest cases: ${result.pages ? result.pages.map((p) => `${p.dir}\\testcases.json`).join(", ") : `${result.dir}\\testcases.json`}`);
    console.log(`BugOps rows: ${result.dir}\\bugops.json`);
  } catch (err) {
    console.error(`\nTest run failed for ${url}:`, err.message);
    process.exitCode = 1;
  }
}
