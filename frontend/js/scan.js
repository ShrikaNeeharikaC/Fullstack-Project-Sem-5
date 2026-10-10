// Scan page: recently-scanned list + scan submission -> live LangGraph crawl -> report

const RECENT_SCANS = [
  { url: "yourapp.com", timestamp: "2 hours ago", bugs: 12, status: "high" },
  { url: "shop.demoapp.io", timestamp: "Yesterday", bugs: 4, status: "low" },
  {
    url: "staging.acme.dev",
    timestamp: "3 days ago",
    bugs: 0,
    status: "resolved",
  },
];

function renderRecentScans() {
  const grid = document.getElementById("recent-grid");
  if (!grid) return;

  if (RECENT_SCANS.length === 0) {
    grid.innerHTML = `<div class="recent-empty">No apps scanned yet. Run your first scan above to see results here.</div>`;
    return;
  }

  grid.innerHTML = RECENT_SCANS.map(
    (scan) => `
    <a class="recent-card" href="dashboard.html?url=${encodeURIComponent(scan.url)}">
      <div class="status-dot-row">
        <span class="status-dot ${scan.status}"></span>
        <span class="timestamp">Last scanned ${scan.timestamp}</span>
      </div>
      <span class="url">${scan.url}</span>
      <span class="bug-count">${scan.bugs} bug${scan.bugs === 1 ? "" : "s"} found</span>
      <span class="view-results">View Results &nbsp;&#8594;</span>
    </a>
  `,
  ).join("");
}

function isLikelyUrl(value) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  // Accept "example.com", "www.example.com", "https://example.com/path"
  return /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+([\/?#].*)?$/i.test(trimmed);
}

const API_BASE = "http://localhost:3000";
const POLL_MS = 1500;

let activeScanId = null;
let pollTimer = null;
let shownQuestionKey = null;
let renderedEvents = 0;

// Page text and LLM output are inserted into the page, so escape them.
function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function setScanButton(button, busy) {
  button.disabled = busy;
  button.textContent = busy ? "Scanning..." : "SCAN NOW";
}

// Starts a LangGraph crawl on the backend, then polls it until it finishes.
async function runScanSequence(url, button) {
  const error = document.getElementById("scan-error");
  const fullUrl = /^https?:\/\//i.test(url) ? url : "https://" + url;

  setScanButton(button, true);
  try {
    const res = await fetch(`${API_BASE}/api/scan`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: fullUrl }),
    });
    const data = await res.json();
    if (!data.success) {
      error.textContent = data.error || "Could not start the scan";
      setScanButton(button, false);
      return;
    }

    activeScanId = data.scanId;
    shownQuestionKey = null;
    renderedEvents = 0;
    showLivePanel(fullUrl);
    pollScan(button);
  } catch (err) {
    console.error(err);
    error.textContent = "Could not connect to backend.";
    setScanButton(button, false);
  }
}

function showLivePanel(url) {
  const container = document.getElementById("results-container");
  container.style.display = "block";
  document.getElementById("result-url-subtitle").textContent = `Crawling ${url}`;
  document.getElementById("crawl-log").innerHTML = "";
  document.getElementById("crawl-question").hidden = true;
  document.getElementById("crawl-stop").disabled = false;
  document.getElementById("results-content").innerHTML = "";
  document.getElementById("raw-json-view").textContent = "";
  container.scrollIntoView({ behavior: "smooth" });
}

async function pollScan(button) {
  clearTimeout(pollTimer);
  const status = document.getElementById("crawl-status");
  let scan;
  try {
    const res = await fetch(`${API_BASE}/api/scan/${activeScanId}`);
    scan = await res.json();
  } catch (err) {
    status.textContent = "Lost connection to backend, retrying...";
    pollTimer = setTimeout(() => pollScan(button), POLL_MS * 2);
    return;
  }
  if (!scan.success) {
    status.textContent = scan.error || "Scan not found";
    finishScan(button);
    return;
  }

  renderEvents(scan.events);
  renderQuestion(scan.question);

  if (scan.status === "running") {
    const acts = scan.events.filter((e) => e.type === "act").length;
    status.textContent = `Crawling... ${acts} action${acts === 1 ? "" : "s"} so far`;
  } else if (scan.status === "waiting_for_user") {
    status.textContent = "Paused: the agent needs your decision below";
  } else if (scan.status === "done") {
    status.textContent = "Scan complete";
    finishScan(button);
    renderReport(scan.report);
    return;
  } else if (scan.status === "error") {
    status.textContent = `Scan failed: ${scan.error}`;
    finishScan(button);
    return;
  }
  pollTimer = setTimeout(() => pollScan(button), POLL_MS);
}

function finishScan(button) {
  document.getElementById("crawl-stop").disabled = true;
  document.getElementById("crawl-question").hidden = true;
  setScanButton(button, false);
}

function renderEvents(events) {
  const log = document.getElementById("crawl-log");
  for (const e of events.slice(renderedEvents)) {
    const li = document.createElement("li");
    li.className = `ev-${e.type}`;
    li.textContent = `[${e.type}] ${e.message}`;
    log.appendChild(li);
  }
  if (events.length > renderedEvents) log.scrollTop = log.scrollHeight;
  renderedEvents = events.length;
}

// Shows the agent's pending question (risky action / form) with one button
// per option. Only re-rendered when the question changes.
function renderQuestion(question) {
  const box = document.getElementById("crawl-question");
  if (!question) {
    box.hidden = true;
    shownQuestionKey = null;
    return;
  }
  const key = question.question + question.action.label;
  if (key === shownQuestionKey) return;
  shownQuestionKey = key;

  const fields = question.action.fields
    ? `<ul>${question.action.fields
        .map((f) => `<li>${esc(f.label || f.placeholder || f.name || f.type)} <em>(${esc(f.type || f.tag)})</em></li>`)
        .join("")}</ul>`
    : "";
  box.innerHTML = `
    <strong>${esc(question.question)}</strong>
    <p>Action: ${esc(question.action.label)}</p>
    ${question.riskReason ? `<p>Why it was flagged: ${esc(question.riskReason)}</p>` : ""}
    ${fields}
    <div class="q-options">
      ${question.options
        .map((o) => `<button type="button" class="btn btn-dark btn-sm" data-answer="${esc(o.value)}">${esc(o.label)}</button>`)
        .join("")}
    </div>`;
  box.hidden = false;

  box.querySelectorAll("button[data-answer]").forEach((btn) => {
    btn.addEventListener("click", async () => {
      box.querySelectorAll("button").forEach((b) => (b.disabled = true));
      try {
        await fetch(`${API_BASE}/api/scan/${activeScanId}/answer`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ answer: btn.dataset.answer }),
        });
      } catch (err) {
        console.error(err);
        box.querySelectorAll("button").forEach((b) => (b.disabled = false));
      }
    });
  });
}

const STOP_REASONS = {
  max_actions: "action limit reached",
  max_states: "screen limit reached",
  time_limit: "time limit reached",
  no_new_screens: "no new screens found recently",
  nothing_left_to_explore: "everything reachable was explored",
  stopped_by_user: "stopped by you",
};

function renderReport(report) {
  const content = document.getElementById("results-content");
  document.getElementById("raw-json-view").textContent = JSON.stringify(report, null, 2);
  if (!report) {
    content.innerHTML = "<p>No report was produced.</p>";
    return;
  }
  const s = report.stats;

  let html = `
    <p>Stopped because: <strong>${esc(STOP_REASONS[report.stopReason] || report.stopReason)}</strong></p>
    <div class="crawl-stats">
      <div><strong>${s.actions}</strong>actions</div>
      <div><strong>${s.screens}</strong>screens</div>
      <div><strong>${s.bugs.total}</strong>bugs</div>
      <div><strong>${s.bugs.high}</strong>high</div>
      <div><strong>${s.bugs.medium}</strong>medium</div>
      <div><strong>${s.bugs.low}</strong>low</div>
      <div><strong>${s.activeSeconds}s</strong>time</div>
      <div><strong>${s.llmCalls}</strong>LLM calls</div>
    </div>`;

  html += `<h3>Bugs found</h3>`;
  html += report.bugs.length
    ? report.bugs
        .map(
          (b) => `
      <div class="bug-item ${esc(b.severity)}">
        <h4>[${esc(b.severity)}] ${esc(b.title)}</h4>
        <p>${esc(b.description)}</p>
        <p><strong>Where:</strong> ${esc(b.url)}, after: ${esc(b.action)}</p>
        ${b.rca ? `<p><strong>Root cause:</strong> ${esc(b.rca)}</p>` : ""}
        ${b.suggested_fix ? `<p><strong>Suggested fix:</strong> ${esc(b.suggested_fix)}</p>` : ""}
      </div>`,
        )
        .join("")
    : "<p>No bugs found in the explored screens.</p>";

  html += `<h3>What the agent did</h3>
    <div class="crawl-table-wrap"><table class="crawl-table">
      <tr><th>#</th><th>Action</th><th>Outcome</th><th>Result</th></tr>
      ${report.actions
        .map(
          (a) => `<tr>
        <td>${a.n}</td>
        <td>${esc(a.label)}</td>
        <td>${esc(a.outcome)}${a.newScreen ? " (new screen)" : ""}</td>
        <td>${esc(a.error || a.summary || a.urlAfter)}</td>
      </tr>`,
        )
        .join("")}
    </table></div>`;

  if (report.skipped.length) {
    html += `<h3>Skipped</h3><ul>${report.skipped
      .map((x) => `<li>${esc(x.label)}: ${esc(x.reason)}</li>`)
      .join("")}</ul>`;
  }

  if (report.landing && !report.landing.error) {
    html += `<h2 style="margin-top: 30px;">Landing page analysis</h2>` + renderAnalysis(report.landing);
  } else if (report.landing?.error) {
    html += `<p>Landing page analysis unavailable: ${esc(report.landing.error)}</p>`;
  }

  content.innerHTML = html;
}

// Landing page analysis (the original single-page prompt's JSON).
function renderAnalysis(analysis) {
  const list = (items) => `<ul>${(items || []).map((a) => `<li>${esc(a)}</li>`).join("")}</ul>`;
  let html = ``;

  if (analysis.page) {
    html += `<h3>Page Overview</h3><ul>
      <li><strong>URL:</strong> ${esc(analysis.page.url || "N/A")}</li>
      <li><strong>Title:</strong> ${esc(analysis.page.title || "N/A")}</li>
      <li><strong>Purpose:</strong> ${esc(analysis.page.purpose || "N/A")}</li>
    </ul>`;
  }

  if (analysis.layout) {
    html += `<h3>Layout</h3><ul>
      <li><strong>Sections:</strong> ${esc((analysis.layout.sections || []).join(", "))}</li>
      <li><strong>Navigation:</strong> ${esc((analysis.layout.navigation || []).join(", "))}</li>
    </ul>`;
  }

  if (analysis.elements) {
    const el = analysis.elements;
    html += `<h3>Elements</h3>
      <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
        <div><strong>Buttons:</strong> ${(el.buttons || []).length}</div>
        <div><strong>Inputs:</strong> ${(el.inputs || []).length}</div>
        <div><strong>Forms:</strong> ${(el.forms || []).length}</div>
        <div><strong>Links:</strong> ${(el.links || []).length}</div>
        <div><strong>Images:</strong> ${(el.images || []).length}</div>
        <div><strong>Interactive:</strong> ${(el.interactive_elements || []).length}</div>
      </div>`;
  }

  if (analysis.possible_actions?.length) {
    html += `<h3>Possible Actions</h3>` + list(analysis.possible_actions);
  }
  if (analysis.potential_issues?.ui_ux?.length) {
    html += `<h3>Potential UI/UX Issues</h3>` + list(analysis.potential_issues.ui_ux);
  }
  if (analysis.potential_issues?.accessibility?.length) {
    html += `<h3>Accessibility Issues</h3>` + list(analysis.potential_issues.accessibility);
  }
  if (analysis.observations?.length) {
    html += `<h3>Observations</h3>` + list(analysis.observations);
  }
  return html;
}

document.addEventListener("DOMContentLoaded", () => {
  renderRecentScans();

  const form = document.getElementById("scan-form");
  const input = document.getElementById("scan-url");
  const error = document.getElementById("scan-error");

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const value = input.value.trim();

    if (!isLikelyUrl(value)) {
      error.textContent = "Please enter a valid URL, e.g. yourapp.com";
      input.focus();
      return;
    }
    error.textContent = "";

    const submitBtn = form.querySelector('button[type="submit"]');
    runScanSequence(value, submitBtn);
  });

  document.getElementById("crawl-stop").addEventListener("click", async (e) => {
    if (!activeScanId) return;
    e.target.disabled = true;
    document.getElementById("crawl-status").textContent =
      "Stopping after the current action...";
    await fetch(`${API_BASE}/api/scan/${activeScanId}/stop`, { method: "POST" }).catch(() => {});
  });
});
