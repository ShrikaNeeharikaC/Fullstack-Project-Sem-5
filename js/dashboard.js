// Dashboard: data-driven bug table with filter/sort/search/pagination/expand/status/automation

const PAGE_SIZE = 5;

const BUGS = [
  {
    id: 1,
    title: "Checkout button unresponsive on mobile Safari",
    page: "/checkout",
    detected: "2026-08-21T06:10:00",
    detectedLabel: "Today, 6:10 AM",
    severity: "high",
    status: "open",
    rca: "The checkout CTA is bound with a touchstart listener that never fires on iOS Safari because the parent container has pointer-events: none applied by a leftover debug style.",
    fix: "Remove the stray pointer-events: none rule on .checkout-wrapper and rebind the click handler using a standard click event instead of touchstart.",
  },
  {
    id: 2,
    title: "Broken image links on product listing page",
    page: "/products",
    detected: "2026-08-21T05:40:00",
    detectedLabel: "Today, 5:40 AM",
    severity: "medium",
    status: "open",
    rca: "Product thumbnails reference a CDN path that was migrated last week; 40% of image URLs still point to the old bucket and return 404.",
    fix: "Update the image base URL in the product feed config to the new CDN host and add a fallback placeholder image for missing assets.",
  },
  {
    id: 3,
    title: "Login form fails to validate empty password field",
    page: "/login",
    detected: "2026-08-20T18:22:00",
    detectedLabel: "Yesterday, 6:22 PM",
    severity: "low",
    status: "in-progress",
    rca: "Client-side validation only checks the email field; the password field has no 'required' attribute or JS check, so empty submissions reach the server.",
    fix: "Add a required attribute and a client-side non-empty check on the password input, with a matching server-side guard as defense in depth.",
  },
  {
    id: 4,
    title: "Cart total miscalculates with multiple discount codes",
    page: "/cart",
    detected: "2026-08-20T14:05:00",
    detectedLabel: "Yesterday, 2:05 PM",
    severity: "high",
    status: "open",
    rca: "Discount codes are applied sequentially against the original subtotal instead of the running total, causing over-discounting when two codes are stacked.",
    fix: "Refactor applyDiscount() to reduce over the running total rather than the original subtotal, and add a regression test for stacked codes.",
  },
  {
    id: 5,
    title: "Navbar overlaps hero text on tablet widths",
    page: "/",
    detected: "2026-08-20T09:30:00",
    detectedLabel: "Yesterday, 9:30 AM",
    severity: "low",
    status: "resolved",
    rca: "The sticky navbar's z-index and the hero section's negative margin collide between 768px–900px viewport widths.",
    fix: "Add a dedicated tablet breakpoint that removes the hero's negative top margin and raises the navbar's z-index.",
  },
  {
    id: 6,
    title: "Search autocomplete throws console error on special characters",
    page: "/search",
    detected: "2026-08-19T16:48:00",
    detectedLabel: "2 days ago, 4:48 PM",
    severity: "medium",
    status: "open",
    rca: "The autocomplete query is passed directly into a RegExp constructor; unescaped characters like '(' or '*' throw a SyntaxError that halts rendering.",
    fix: "Escape user input before constructing the RegExp, or switch to a plain substring match for the autocomplete filter.",
  },
  {
    id: 7,
    title: "Profile avatar upload silently fails above 5MB",
    page: "/settings/profile",
    detected: "2026-08-19T11:15:00",
    detectedLabel: "2 days ago, 11:15 AM",
    severity: "medium",
    status: "ignored",
    rca: "The upload endpoint enforces a 5MB limit server-side but the client shows a generic 'Something went wrong' toast instead of a size-specific error.",
    fix: "Validate file size client-side before upload and show a clear 'File must be under 5MB' message instead of the generic failure toast.",
  },
  {
    id: 8,
    title: "Footer links 404 after locale switch",
    page: "/footer",
    detected: "2026-08-18T20:02:00",
    detectedLabel: "3 days ago, 8:02 PM",
    severity: "low",
    status: "open",
    rca: "Footer link hrefs are hardcoded to the default locale prefix and don't update when the user switches languages.",
    fix: "Generate footer link hrefs from the current locale context instead of a hardcoded prefix.",
  },
  {
    id: 9,
    title: "Dashboard charts fail to render on Firefox",
    page: "/dashboard",
    detected: "2026-08-18T13:27:00",
    detectedLabel: "3 days ago, 1:27 PM",
    severity: "high",
    status: "resolved",
    rca: "The charting library relies on a Chromium-only Canvas API (roundRect) without a polyfill, throwing a TypeError on Firefox and Safari.",
    fix: "Add a roundRect polyfill or switch to a manual path-drawing implementation compatible with all evergreen browsers.",
  },
  {
    id: 10,
    title: "Signup confirmation email delayed by 10+ minutes",
    page: "/signup",
    detected: "2026-08-17T10:00:00",
    detectedLabel: "4 days ago, 10:00 AM",
    severity: "medium",
    status: "open",
    rca: "Confirmation emails are queued through a shared low-priority worker that also processes marketing email, causing backlog during campaign sends.",
    fix: "Move transactional emails (signup, password reset) to a dedicated high-priority queue separate from marketing sends.",
  },
  {
    id: 11,
    title: "Pricing page CTA button color fails contrast check",
    page: "/pricing",
    detected: "2026-08-16T08:12:00",
    detectedLabel: "5 days ago, 8:12 AM",
    severity: "low",
    status: "open",
    rca: "The 'Get Started' button uses a light lavender background with white text, giving a contrast ratio of 2.1:1 — below WCAG AA's 4.5:1 minimum.",
    fix: "Darken the button background or switch to dark text so the contrast ratio meets WCAG AA for normal text.",
  },
];

const AUTOMATION_LOGS = [];

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
            <div class="bug-title">${bug.title}</div>
            <div class="bug-meta">${bug.page} &middot; ${bug.detectedLabel}</div>
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
          ${expandedType === "rca" ? `<h5>Root Cause Analysis</h5><p>${bug.rca}</p>` : ""}
          ${expandedType === "fix" ? `<h5>Suggested Fix</h5><p>${bug.fix}</p>` : ""}
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
      <span class="log-text">${bug.title} &middot; ${bug.page}</span>
      <span class="log-time">${bug.detectedLabel}</span>
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
      <span class="log-text">Automated reproduction triggered for "${log.title}" on ${log.page}</span>
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

function initTrackedUrl() {
  const params = new URLSearchParams(window.location.search);
  const url = params.get("url");
  if (url) {
    document.getElementById("tracked-url").textContent = url;
  }
}

document.addEventListener("DOMContentLoaded", () => {
  initTrackedUrl();
  renderStats();
  renderTable();

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
  document.getElementById("rescan-btn").addEventListener("click", () => {
    document.getElementById("last-scanned-text").textContent = "Just now";
    showToast("Re-scan started — this may take up to a minute.");
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
    showToast(`Automation triggered on ${pendingBugForModal.page}`);
    closeModal();
  });

  // Settings switches
  document.querySelectorAll(".switch").forEach((sw) => {
    sw.addEventListener("click", () => sw.classList.toggle("on"));
  });
});
