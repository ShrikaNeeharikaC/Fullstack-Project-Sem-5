// Terminal runner for the LangGraph crawler (until the frontend is built).
//   npm run crawl -- https://demo.playwright.dev/todomvc/
// Questions about risky actions, forms and login are asked here in the terminal.
import "dotenv/config";
import readline from "readline/promises";
import { stdin, stdout } from "process";
import { startScan, stopScan } from "./crawler/scanManager.js";
import { getCrawlLimits } from "./crawler/config.js";

const url = process.argv[2];
if (!url) {
  console.error("Usage: npm run crawl -- <url>");
  process.exit(1);
}

const rl = readline.createInterface({ input: stdin, output: stdout });

async function askUser(question) {
  console.log(`\n⏸  ${question.question}`);
  console.log(`   Action: ${question.action.label}`);
  if (question.riskReason) console.log(`   Why it was flagged: ${question.riskReason}`);
  if (question.action.fields) {
    for (const f of question.action.fields) {
      console.log(`   - field: ${f.label || f.placeholder || f.name || f.type} (${f.type || f.tag})`);
    }
  }
  question.options.forEach((o, i) => console.log(`   ${i + 1}) ${o.label}`));

  for (;;) {
    const reply = (await rl.question("   Choose a number: ")).trim();
    const option = question.options[Number(reply) - 1];
    if (option?.needsCredentials) {
      const username = (await rl.question("   Email / username: ")).trim();
      const password = await rl.question("   Password (shown as you type): ");
      return { value: option.value, credentials: { username, password } };
    }
    if (option) return option.value;
    console.log("   Please type one of the numbers above.");
  }
}

console.log("Limits:", getCrawlLimits());
const scan = startScan(url, {
  askUser,
  onEvent: (e) => {
    if (e.type !== "question") console.log(`[${e.type}] ${e.message}`);
  },
});

// Ctrl+C once: stop early but still write the report. Twice: quit now.
let interrupted = false;
process.on("SIGINT", () => {
  if (interrupted) process.exit(130);
  interrupted = true;
  console.log("\nStopping after the current action (Ctrl+C again to quit immediately)...");
  stopScan(scan.scanId);
});

try {
  const report = await scan.done;
  const s = report.stats;
  console.log("\n=== Scan report ===");
  console.log(`Stopped because: ${report.stopReason}`);
  console.log(`Actions: ${s.actions} | Screens: ${s.screens} | LLM calls: ${s.llmCalls} | Time: ${s.activeSeconds}s`);
  console.log(`Bugs: ${s.bugs.total} (high ${s.bugs.high}, medium ${s.bugs.medium}, low ${s.bugs.low})`);
  for (const b of report.bugs) console.log(`  [${b.severity}] ${b.title}`);
  console.log(`Skipped: ${s.skipped} | Left untested: ${s.notTested}`);
  console.log(`\nFull report: ${scan.session.dir}\\report.json`);
} catch (err) {
  console.error("\nScan failed:", err.message);
  process.exitCode = 1;
} finally {
  rl.close();
}
