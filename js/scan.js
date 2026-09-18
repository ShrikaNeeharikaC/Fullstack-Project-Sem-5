// Scan page: recently-scanned list + scan submission -> loading overlay -> dashboard

const RECENT_SCANS = [
  { url: "yourapp.com", timestamp: "2 hours ago", bugs: 12, status: "high" },
  { url: "shop.demoapp.io", timestamp: "Yesterday", bugs: 4, status: "low" },
  { url: "staging.acme.dev", timestamp: "3 days ago", bugs: 0, status: "resolved" },
];

function renderRecentScans() {
  const grid = document.getElementById("recent-grid");
  if (!grid) return;

  if (RECENT_SCANS.length === 0) {
    grid.innerHTML = `<div class="recent-empty">No apps scanned yet. Run your first scan above to see results here.</div>`;
    return;
  }

  grid.innerHTML = RECENT_SCANS.map((scan) => `
    <a class="recent-card" href="dashboard.html?url=${encodeURIComponent(scan.url)}">
      <div class="status-dot-row">
        <span class="status-dot ${scan.status}"></span>
        <span class="timestamp">Last scanned ${scan.timestamp}</span>
      </div>
      <span class="url">${scan.url}</span>
      <span class="bug-count">${scan.bugs} bug${scan.bugs === 1 ? "" : "s"} found</span>
      <span class="view-results">View Results &nbsp;&#8594;</span>
    </a>
  `).join("");
}

function isLikelyUrl(value) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  // Accept "example.com", "www.example.com", "https://example.com/path"
  return /^(https?:\/\/)?[a-z0-9-]+(\.[a-z0-9-]+)+([\/?#].*)?$/i.test(trimmed);
}

function runScanSequence(url) {
  const overlay = document.getElementById("loading-overlay");
  const loadingUrl = document.getElementById("loading-url");
  const fill = document.getElementById("progress-bar-fill");
  const steps = Array.from(document.querySelectorAll(".progress-step"));

  loadingUrl.textContent = url;
  overlay.classList.add("visible");

  steps.forEach((s) => s.classList.remove("active", "done"));
  fill.style.width = "0%";

  const stepDurations = [900, 900, 900]; // ms per step
  let elapsed = 0;

  steps.forEach((step, i) => {
    setTimeout(() => {
      steps.forEach((s, j) => {
        if (j < i) s.classList.add("done");
      });
      step.classList.add("active");
      fill.style.width = `${Math.round(((i + 1) / steps.length) * 100)}%`;
    }, elapsed);
    elapsed += stepDurations[i];
  });

  setTimeout(() => {
    steps.forEach((s) => { s.classList.remove("active"); s.classList.add("done"); });
    setTimeout(() => {
      window.location.href = `dashboard.html?url=${encodeURIComponent(url)}`;
    }, 350);
  }, elapsed);
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
    runScanSequence(value);
  });
});
