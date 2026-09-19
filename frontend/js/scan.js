// Scan page: recently-scanned list + scan submission -> loading overlay -> dashboard

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

async function runScanSequence(url, button) {
  const overlay = document.getElementById("loading-overlay");
  const loadingUrl = document.getElementById("loading-url");

  loadingUrl.textContent = url;
  overlay.classList.add("visible");
  button.disabled = true;
  button.textContent = "Analyzing webpage...";

  try {
    let fullUrl = url;
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
      fullUrl = "https://" + url;
    }

    const res = await fetch("http://localhost:3000/api/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: fullUrl }),
    });

    const data = await res.json();

    overlay.classList.remove("visible");
    button.disabled = false;
    button.textContent = "SCAN NOW";

    if (!data.success) {
      document.getElementById("scan-error").textContent =
        data.error || "Analysis failed";
      return;
    }

    displayResults(data.analysis, url);
  } catch (err) {
    console.error(err);
    overlay.classList.remove("visible");
    button.disabled = false;
    button.textContent = "SCAN NOW";
    document.getElementById("scan-error").textContent =
      "Could not connect to backend.";
  }
}

function displayResults(analysis, url) {
  const container = document.getElementById("results-container");
  const content = document.getElementById("results-content");
  const subtitle = document.getElementById("result-url-subtitle");
  const rawView = document.getElementById("raw-json-view");

  container.style.display = "block";
  subtitle.textContent = `Results for ${url}`;

  rawView.textContent = JSON.stringify(analysis, null, 2);

  let html = ``;

  // Page Overview
  if (analysis.page) {
    html += `<h3>Page Overview</h3><ul>
      <li><strong>URL:</strong> ${analysis.page.url || "N/A"}</li>
      <li><strong>Title:</strong> ${analysis.page.title || "N/A"}</li>
      <li><strong>Purpose:</strong> ${analysis.page.purpose || "N/A"}</li>
    </ul>`;
  }

  // Layout
  if (analysis.layout) {
    html += `<h3>Layout</h3><ul>
      <li><strong>Sections:</strong> ${(analysis.layout.sections || []).join(", ")}</li>
      <li><strong>Navigation:</strong> ${(analysis.layout.navigation || []).join(", ")}</li>
    </ul>`;
  }

  // Elements
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
      </div>
      <p style="margin-top: 10px; font-size: 0.9em; color: #555;">
        (See Raw JSON for full element details)
      </p>
    `;
  }

  // Possible Actions
  if (analysis.possible_actions && analysis.possible_actions.length > 0) {
    html += `<h3>Possible Actions</h3><ul>
      ${analysis.possible_actions.map((a) => `<li>${a}</li>`).join("")}
    </ul>`;
  }

  // Issues
  if (analysis.potential_issues) {
    if (
      analysis.potential_issues.ui_ux &&
      analysis.potential_issues.ui_ux.length > 0
    ) {
      html += `<h3>Potential UI/UX Issues</h3><ul style="color: #d9534f;">
        ${analysis.potential_issues.ui_ux.map((a) => `<li>${a}</li>`).join("")}
      </ul>`;
    }
    if (
      analysis.potential_issues.accessibility &&
      analysis.potential_issues.accessibility.length > 0
    ) {
      html += `<h3>Accessibility Issues</h3><ul style="color: #d9534f;">
        ${analysis.potential_issues.accessibility.map((a) => `<li>${a}</li>`).join("")}
      </ul>`;
    }
  }

  // Observations
  if (analysis.observations && analysis.observations.length > 0) {
    html += `<h3>Observations</h3><ul>
      ${analysis.observations.map((a) => `<li>${a}</li>`).join("")}
    </ul>`;
  }

  content.innerHTML = html;

  // Scroll to results
  container.scrollIntoView({ behavior: "smooth" });
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
});
