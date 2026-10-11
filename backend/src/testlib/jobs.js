import { runSite } from "./runner.js";

// Test runs started over HTTP: start one, then poll it (a run takes minutes).
const runs = new Map();

// run.done resolves when the run settles (it never rejects; check run.status).
export function startTestRun(url, options = {}, { userId = null } = {}) {
  const runId = `tests-${Date.now()}`;
  const run = { runId, url, userId, status: "running", events: [], result: null, error: null };
  runs.set(runId, run);
  run.done = runSite(url, { ...options, runId, onEvent: (e) => run.events.push(e) })
    .then((result) => {
      run.result = result;
      run.status = "done";
    })
    .catch((err) => {
      run.error = err.message;
      run.status = "error";
    });
  return run;
}

export function getTestRun(runId) {
  return runs.get(runId) || null;
}
