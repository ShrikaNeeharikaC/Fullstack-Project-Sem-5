// Dashboard: bug table with filter/sort/search/pagination/expand/status/automation.
// Rows come from the backend's saved scans (crawler + test library); there is
// no demo data.

const PAGE_SIZE = 5;

let BUGS = [];

const AUTOMATION_LOGS = [];


// The URL the dashboard is showing (from ?url=, or the most recent scan).
let trackedUrl = null;
let lastScannedAt = null;

// Titles, RCA and fixes come from scanned pages and the LLM, so escape them.
function esc(value) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function fullUrl(url) {
  return /^https?:\/\//i.test(url) ? url : "https://" + url;
}

function displayUrl(url) {
  return String(url || "").replace(/^https?:\/\//i, "").replace(/#\/?$/, "").replace(/\/$/, "");
}

// "Just now", "5 min ago", "2 hours ago", "Yesterday", "3 days ago", or a date.
function relativeTime(iso) {
  if (!iso) return "never";
  const then = new Date(iso);
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "Yesterday";
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// Row timestamps: "Today, 6:10 AM", "Yesterday, 2:05 PM", "3 days ago, 1:27 PM".
function detectedLabel(iso) {
  if (!iso) return "";
  const then = new Date(iso);
  const time = then.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  const days = Math.round((startOfDay(new Date()) - startOfDay(then)) / 86400000);
  if (days <= 0) return `Today, ${time}`;
  if (days === 1) return `Yesterday, ${time}`;
  if (days < 7) return `${days} days ago, ${time}`;
  return `${then.toLocaleDateString("en-US", { month: "short", day: "numeric" })}, ${time}`;
}

// Statuses the user picks are kept in this browser, per bug.
function savedStatus(bug) {
  try {
    return localStorage.getItem(`bugops-status:${bug.key}`);
  } catch {
    return null;
  }
}
function saveStatus(bug) {
  try {
    localStorage.setItem(`bugops-status:${bug.key}`, bug.status);
  } catch {}
}

function setEmptyMessage(title, text) {
  const box = document.getElementById("empty-state");
  box.querySelector("h3").textContent = title;
  box.querySelector("p").innerHTML = text;
}

// Header: URL, last scanned, and a status dot for the worst open bug.
function renderHeader() {
  document.getElementById("tracked-url").textContent = trackedUrl ? displayUrl(trackedUrl) : "No scans yet";
  document.getElementById("last-scanned-text").textContent = relativeTime(lastScannedAt);
  const open = BUGS.filter((b) => b.status !== "resolved" && b.status !== "ignored");
  const worst = ["high", "medium", "low"].find((s) => open.some((b) => b.severity === s));
  const dot = document.getElementById("status-dot");
  dot.className = `status-dot ${worst || "resolved"}`;
  dot.title = worst ? `Open ${worst}-severity bugs` : "No open bugs";
}

// Loads the saved results for the tracked URL (or the latest scan).
async function loadBugs(url) {
  try {
    const query = url ? `?url=${encodeURIComponent(fullUrl(url))}` : "";
    const res = await apiFetch(`/api/bugops${query}`);
    const data = await res.json();
    if (!data.success) throw new Error(data.error || "Could not load results");

    trackedUrl = data.url || url || null;
    lastScannedAt = data.lastScanned;
    BUGS = data.rows.map((row) => ({
      ...row,
      status: savedStatus(row) || row.status,
      detectedLabel: detectedLabel(row.detected),
    }));
    state.page = 1;
    state.expanded = {};
    if (!trackedUrl) {
      setEmptyMessage("No scans yet", 'Run your first scan from the <a href="scan.html">Scan page</a>.');
    } else if (!BUGS.length) {
      setEmptyMessage(
        data.lastScanned ? "No bugs found" : "This URL hasn't been scanned yet",
        data.lastScanned ? "The last scan found no issues. Try Re-Scan for a deeper test run." : "Click Re-Scan to test it.",
      );
    } else {
      setEmptyMessage("No bugs found", "Try adjusting your search or filters.");
    }
    renderHeader();
    renderStats();
    renderTable();
    return true;
  } catch (err) {
    console.error(err);
    BUGS = [];
    setEmptyMessage("Can't reach the BugOps backend", "Start it with <code>npm start</code> in the backend folder, then reload.");
    renderHeader();
    renderStats();
    renderTable();
    return false;
  }
}

// Re-Scan: runs the reusable test library on the URL, then reloads the rows.
async function runTests(url, button) {
  button.disabled = true;
  try {
    const res = await apiFetch(`/api/tests`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ url: fullUrl(url) }),
    });
    const start = await res.json();
    if (!start.success) throw new Error(start.error || "Could not start tests");
    showToast("Test run started — this can take a few minutes.");

    for (;;) {
      await new Promise((r) => setTimeout(r, 3000));
      const run = await (await apiFetch(`/api/tests/${start.runId}`)).json();
      const last = run.events?.[run.events.length - 1];
      if (last) document.getElementById("last-scanned-text").textContent = last.message;
      if (run.status === "done") {
        await loadBugs(url);
        const s = run.result.summary;
        showToast(`Tests done: ${s.pass} passed, ${s.fail} failed`);
        return;
      }
      if (run.status === "error") throw new Error(run.error);
    }
  } catch (err) {
    showToast(`Test run failed: ${err.message}`);
    loadBugs(url);
  } finally {
    button.disabled = false;
  }
}

let state = {
  sort: "priority",
  statusFilter: "all",
  search: "",
  page: 1,
  expanded: {}, // { [bugId]: 'rca' | 'fix' | null }
};

const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };

function getFilteredSortedBugs() {
  let list = BUGS.slice();

  if (state.statusFilter !== "all") {
    list = list.filter((b) => b.status === state.statusFilter);
  }
  if (state.search.trim()) {
    const q = state.search.trim().toLowerCase();
    list = list.filter(
      (b) => b.title.toLowerCase().includes(q) || b.page.toLowerCase().includes(q)
    );
  }

  if (state.sort === "priority") {
    list.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  } else {
    list.sort((a, b) => new Date(b.detected) - new Date(a.detected));
  }

  return list;
}

function renderStats() {
  const strip = document.getElementById("stats-strip");
  const total = BUGS.length;
  const high = BUGS.filter((b) => b.severity === "high" && b.status !== "resolved").length;
  const medium = BUGS.filter((b) => b.severity === "medium" && b.status !== "resolved").length;
  const low = BUGS.filter((b) => b.severity === "low" && b.status !== "resolved").length;
  const resolved = BUGS.filter((b) => b.status === "resolved").length;

  strip.innerHTML = `
    <div class="stat-card"><div class="stat-value">${total}</div><div class="stat-label">Total Bugs</div></div>
    <div class="stat-card high"><div class="stat-value">${high}</div><div class="stat-label">High Priority</div></div>
    <div class="stat-card medium"><div class="stat-value">${medium}</div><div class="stat-label">Medium Priority</div></div>
    <div class="stat-card low"><div class="stat-value">${low}</div><div class="stat-label">Low Priority</div></div>
    <div class="stat-card resolved"><div class="stat-value">${resolved}</div><div class="stat-label">Bugs Resolved</div></div>
  `;
}

function severityBadge(sev) {
  return `<span class="severity-badge ${sev}"><span class="status-dot ${sev}"></span>${sev}</span>`;
}

function renderTable() {
  const tbody = document.getElementById("bug-table-body");
  const emptyState = document.getElementById("empty-state");
  const filtered = getFilteredSortedBugs();

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  if (state.page > totalPages) state.page = totalPages;
  const start = (state.page - 1) * PAGE_SIZE;
  const pageItems = filtered.slice(start, start + PAGE_SIZE);

  if (filtered.length === 0) {
    tbody.innerHTML = "";
    emptyState.style.display = "block";
    document.getElementById("pagination").innerHTML = "";
    return;
  }
  emptyState.style.display = "none";

  tbody.innerHTML = pageItems.map((bug) => {
    const expandedType = state.expanded[bug.id];
    return `
    <tr class="bug-row" data-id="${bug.id}">
      <td>
        <div class="bug-title-cell">
          <div class="bug-thumb">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="14" rx="2"/><path d="M3 13l4-4 4 4 6-6 4 4"/></svg>
          </div>
          <div>
            <div class="bug-title">${esc(bug.title)}</div>
            <div class="bug-meta">${esc(bug.page)} &middot; ${esc(bug.detectedLabel)}</div>
          </div>
        </div>
      </td>
      <td class="center"><button class="btn btn-chip btn-sm expand-btn" data-type="rca" data-id="${bug.id}">RCA</button></td>
      <td class="center"><button class="btn btn-chip btn-sm expand-btn" data-type="fix" data-id="${bug.id}">Fix</button></td>
      <td class="center">${severityBadge(bug.severity)}</td>
      <td class="center">
        <select class="status-select" data-id="${bug.id}">
          <option value="open" ${bug.status === "open" ? "selected" : ""}>Open</option>
          <option value="in-progress" ${bug.status === "in-progress" ? "selected" : ""}>In Progress</option>
          <option value="resolved" ${bug.status === "resolved" ? "selected" : ""}>Resolved</option>
          <option value="ignored" ${bug.status === "ignored" ? "selected" : ""}>Ignored</option>
        </select>
      </td>
      <td class="center">
        <button class="btn btn-dark btn-sm go-to-site-btn" data-id="${bug.id}">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" width="14" height="14"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><line x1="12" y1="7" x2="12" y2="11"/></svg>
          Go to Site
        </button>
      </td>
    </tr>
    <tr class="expand-detail">
      <td colspan="6">
        <div class="expand-detail-inner ${expandedType ? "open" : ""}">
          ${expandedType === "rca" ? `<h5>Root Cause Analysis</h5><p>${esc(bug.rca)}</p>` : ""}
          ${expandedType === "fix" ? `<h5>Suggested Fix</h5><p>${esc(bug.fix)}</p>` : ""}
        </div>
      </td>
    </tr>
  `;
  }).join("");

  renderPagination(filtered.length, totalPages);
}

function renderPagination(totalItems, totalPages) {
  const el = document.getElementById("pagination");
  if (totalItems <= PAGE_SIZE) {
    el.innerHTML = "";
    return;
  }
  let buttons = `<button class="page-btn" id="page-prev" ${state.page === 1 ? "disabled" : ""}>&#8592;</button>`;
  for (let i = 1; i <= totalPages; i++) {
    buttons += `<button class="page-btn ${i === state.page ? "active" : ""}" data-page="${i}">${i}</button>`;
  }
  buttons += `<button class="page-btn" id="page-next" ${state.page === totalPages ? "disabled" : ""}>&#8594;</button>`;
  el.innerHTML = buttons;
}

function renderReportsPanel() {
  const list = document.getElementById("reports-list");
  list.innerHTML = BUGS.map((bug) => `
    <div class="log-item">
      <span class="status-dot ${bug.severity}"></span>
      <span class="log-text">${esc(bug.title)} &middot; ${esc(bug.page)}</span>
      <span class="log-time">${esc(bug.detectedLabel)}</span>
    </div>
  `).join("");
}

function renderAutomationLogs() {
  const list = document.getElementById("automation-log-list");
  if (AUTOMATION_LOGS.length === 0) {
    list.innerHTML = `<div class="empty-state" style="padding:32px 12px;"><h3>No automation runs yet</h3><p>Confirm "Go to Site" on a bug to log an automated run here.</p></div>`;
    return;
  }
  list.innerHTML = AUTOMATION_LOGS.slice().reverse().map((log) => `
    <div class="log-item">
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="11" width="18" height="10" rx="2"/><circle cx="12" cy="5" r="2"/><line x1="12" y1="7" x2="12" y2="11"/></svg>
      <span class="log-text">Automated reproduction triggered for "${esc(log.title)}" on ${esc(log.page)}</span>
      <span class="log-time">${log.time}</span>
    </div>
  `).join("");
}

function showToast(text) {
  const toast = document.getElementById("toast");
  document.getElementById("toast-text").textContent = text;
  toast.classList.add("visible");
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => toast.classList.remove("visible"), 2800);
}

let pendingBugForModal = null;

function openModal(bug) {
  pendingBugForModal = bug;
  document.getElementById("modal-url").textContent = bug.page;
  document.getElementById("confirm-modal").classList.add("visible");
}
function closeModal() {
  pendingBugForModal = null;
  document.getElementById("confirm-modal").classList.remove("visible");
}

function switchView(viewName) {
  document.querySelectorAll(".dashboard-view").forEach((v) => v.classList.remove("active"));
  document.getElementById(`view-${viewName}`).classList.add("active");
  document.querySelectorAll(".sidebar-link").forEach((l) => l.classList.remove("active"));
  document.querySelector(`.sidebar-link[data-view="${viewName}"]`).classList.add("active");

  if (viewName === "reports") renderReportsPanel();
  if (viewName === "logs") renderAutomationLogs();
}

async function initTrackedUrl() {
  const params = new URLSearchParams(window.location.search);
  const url = params.get("url");
  const ok = await loadBugs(url);
  if (ok && !url && trackedUrl) {
    params.set("url", trackedUrl);
    history.replaceState(null, "", `?${params}`);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  renderStats();
  renderTable();
  initTrackedUrl();

  // Sidebar navigation
  document.querySelectorAll(".sidebar-link").forEach((link) => {
    link.addEventListener("click", () => switchView(link.dataset.view));
  });

  // Sort / filter / search
  document.getElementById("sort-select").addEventListener("change", (e) => {
    state.sort = e.target.value;
    state.page = 1;
    renderTable();
  });
  document.getElementById("status-filter").addEventListener("change", (e) => {
    state.statusFilter = e.target.value;
    state.page = 1;
    renderTable();
  });
  document.getElementById("filter-toggle-btn").addEventListener("click", () => {
    const select = document.getElementById("status-filter");
    const options = ["all", "open", "in-progress", "resolved", "ignored"];
    const next = (options.indexOf(select.value) + 1) % options.length;
    select.value = options[next];
    state.statusFilter = options[next];
    state.page = 1;
    renderTable();
  });
  document.getElementById("search-input").addEventListener("input", (e) => {
    state.search = e.target.value;
    state.page = 1;
    renderTable();
  });

  // Re-scan button
  document.getElementById("rescan-btn").addEventListener("click", (e) => {
    if (!trackedUrl) {
      showToast("Open the dashboard from a scan (?url=...) to run tests.");
      return;
    }
    runTests(trackedUrl, e.currentTarget);
  });

  // Delegated table events
  document.getElementById("bug-table-body").addEventListener("click", (e) => {
    const expandBtn = e.target.closest(".expand-btn");
    if (expandBtn) {
      const id = Number(expandBtn.dataset.id);
      const type = expandBtn.dataset.type;
      state.expanded[id] = state.expanded[id] === type ? null : type;
      renderTable();
      return;
    }
    const goBtn = e.target.closest(".go-to-site-btn");
    if (goBtn) {
      const id = Number(goBtn.dataset.id);
      const bug = BUGS.find((b) => b.id === id);
      openModal(bug);
      return;
    }
  });
  document.getElementById("bug-table-body").addEventListener("change", (e) => {
    if (e.target.classList.contains("status-select")) {
      const id = Number(e.target.dataset.id);
      const bug = BUGS.find((b) => b.id === id);
      bug.status = e.target.value;
      saveStatus(bug);
      renderHeader();
      renderStats();
      renderTable();
    }
  });

  // Pagination
  document.getElementById("pagination").addEventListener("click", (e) => {
    const btn = e.target.closest(".page-btn");
    if (!btn || btn.disabled) return;
    if (btn.id === "page-prev") state.page -= 1;
    else if (btn.id === "page-next") state.page += 1;
    else state.page = Number(btn.dataset.page);
    renderTable();
    document.querySelector(".table-wrap").scrollIntoView({ behavior: "smooth", block: "nearest" });
  });

  // Modal
  document.getElementById("modal-cancel").addEventListener("click", closeModal);
  document.getElementById("confirm-modal").addEventListener("click", (e) => {
    if (e.target.id === "confirm-modal") closeModal();
  });
  document.getElementById("modal-confirm").addEventListener("click", () => {
    if (!pendingBugForModal) return;
    AUTOMATION_LOGS.push({
      title: pendingBugForModal.title,
      page: pendingBugForModal.page,
      time: "Just now",
    });
    if (pendingBugForModal.url) window.open(pendingBugForModal.url, "_blank", "noopener");
    showToast(`Opened ${pendingBugForModal.page}`);
    closeModal();
  });

  // Settings switches
  document.querySelectorAll(".switch").forEach((sw) => {
    sw.addEventListener("click", () => sw.classList.toggle("on"));
  });
});
