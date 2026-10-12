// Dashboard: bug table with filter/sort/search/pagination/expand/status/automation.
// Rows come from the backend's saved scans (crawler + test library); there is
// no demo data.
import { Fragment, useEffect, useRef, useState } from "react";
import Navbar from "../components/Navbar.jsx";
import { apiFetch } from "../lib/auth.js";
import { displayUrl, relativeTime } from "../lib/format.js";
import { mount } from "../lib/mount.jsx";

const PAGE_SIZE = 5;
const SEVERITY_RANK = { high: 0, medium: 1, low: 2 };
const STATUS_OPTIONS = ["all", "open", "in-progress", "resolved", "ignored"];

function fullUrl(url) {
  return /^https?:\/\//i.test(url) ? url : "https://" + url;
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

const DEFAULT_EMPTY = { title: "No bugs found", text: "Try adjusting your search or filters." };

// ---------- Icons ----------

const RobotIcon = (props) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" {...props}>
    <rect x="3" y="11" width="18" height="10" rx="2" /><circle cx="12" cy="5" r="2" /><line x1="12" y1="7" x2="12" y2="11" />
  </svg>
);

const SIDEBAR = [
  {
    view: "dashboard",
    label: "Dashboard",
    icon: <><rect x="3" y="3" width="8" height="8" rx="1.5" /><rect x="13" y="3" width="8" height="8" rx="1.5" /><rect x="3" y="13" width="8" height="8" rx="1.5" /><rect x="13" y="13" width="8" height="8" rx="1.5" /></>,
  },
  {
    view: "reports",
    label: "Bug Reports",
    icon: <><path d="M14 3H6a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z" /><polyline points="14 3 14 9 20 9" /><line x1="8" y1="13" x2="16" y2="13" /><line x1="8" y1="17" x2="13" y2="17" /></>,
  },
  {
    view: "logs",
    label: "Automation Logs",
    icon: <><circle cx="12" cy="12" r="9" /><polyline points="12 7 12 12 16 14" /></>,
  },
  {
    view: "settings",
    label: "Settings",
    icon: <><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" /></>,
  },
];

const SETTINGS = [
  { key: "email", label: "Email notifications", hint: "Get notified when a scan finishes", on: true },
  { key: "autoscan", label: "Auto re-scan daily", hint: "Automatically re-scan your tracked app every 24 hours", on: false },
  { key: "highonly", label: "High-priority alerts only", hint: "Only notify for high severity bugs", on: false },
];

function SeverityBadge({ sev }) {
  return (
    <span className={`severity-badge ${sev}`}>
      <span className={`status-dot ${sev}`}></span>
      {sev}
    </span>
  );
}

function StatsStrip({ bugs }) {
  const count = (sev) => bugs.filter((b) => b.severity === sev && b.status !== "resolved").length;
  return (
    <div className="stats-strip" id="stats-strip">
      <div className="stat-card"><div className="stat-value">{bugs.length}</div><div className="stat-label">Total Bugs</div></div>
      <div className="stat-card high"><div className="stat-value">{count("high")}</div><div className="stat-label">High Priority</div></div>
      <div className="stat-card medium"><div className="stat-value">{count("medium")}</div><div className="stat-label">Medium Priority</div></div>
      <div className="stat-card low"><div className="stat-value">{count("low")}</div><div className="stat-label">Low Priority</div></div>
      <div className="stat-card resolved"><div className="stat-value">{bugs.filter((b) => b.status === "resolved").length}</div><div className="stat-label">Bugs Resolved</div></div>
    </div>
  );
}

// ---------- Page ----------

function Dashboard() {
  const [bugs, setBugs] = useState([]);
  const [loaded, setLoaded] = useState(false);
  const [trackedUrl, setTrackedUrl] = useState(null);
  const [lastScannedAt, setLastScannedAt] = useState(null);
  const [progressText, setProgressText] = useState(null); // test-run progress shown in place of "Last scanned"
  const [empty, setEmpty] = useState(DEFAULT_EMPTY);

  const [sort, setSort] = useState("priority");
  const [statusFilter, setStatusFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [expanded, setExpanded] = useState({}); // { [bugId]: 'rca' | 'fix' | null }

  const [view, setView] = useState("dashboard");
  const [automationLogs, setAutomationLogs] = useState([]);
  const [settings, setSettings] = useState(() => Object.fromEntries(SETTINGS.map((s) => [s.key, s.on])));
  const [rescanning, setRescanning] = useState(false);

  const [toast, setToast] = useState({ text: "", visible: false });
  const toastTimer = useRef(null);
  const [modal, setModal] = useState({ bug: null, visible: false });
  const tableWrapRef = useRef(null);

  const showToast = (text) => {
    setToast({ text, visible: true });
    clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast((t) => ({ ...t, visible: false })), 2800);
  };

  // Loads the saved results for the tracked URL (or the latest scan).
  const loadBugs = async (url) => {
    try {
      const query = url ? `?url=${encodeURIComponent(fullUrl(url))}` : "";
      const res = await apiFetch(`/api/bugops${query}`);
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Could not load results");

      const tracked = data.url || url || null;
      const rows = data.rows.map((row) => ({
        ...row,
        status: savedStatus(row) || row.status,
        detectedLabel: detectedLabel(row.detected),
      }));
      setTrackedUrl(tracked);
      setLastScannedAt(data.lastScanned);
      setBugs(rows);
      setPage(1);
      setExpanded({});
      if (!tracked) {
        setEmpty({ title: "No scans yet", text: <>Run your first scan from the <a href="scan.html">Scan page</a>.</> });
      } else if (!rows.length) {
        setEmpty(
          data.lastScanned
            ? { title: "No bugs found", text: "The last scan found no issues. Try Re-Scan for a deeper test run." }
            : { title: "This URL hasn't been scanned yet", text: "Click Re-Scan to test it." },
        );
      } else {
        setEmpty(DEFAULT_EMPTY);
      }
      return { ok: true, tracked };
    } catch (err) {
      console.error(err);
      setBugs([]);
      setEmpty({ title: "Can't reach the BugOps backend", text: <>Start it with <code>npm start</code> in the backend folder, then reload.</> });
      return { ok: false };
    } finally {
      setLoaded(true);
      setProgressText(null);
    }
  };

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const url = params.get("url");
    loadBugs(url).then(({ ok, tracked }) => {
      if (ok && !url && tracked) {
        params.set("url", tracked);
        history.replaceState(null, "", `?${params}`);
      }
    });
    return () => clearTimeout(toastTimer.current);
  }, []);

  // Re-Scan: runs the reusable test library on the URL, then reloads the rows.
  const runTests = async (url) => {
    setRescanning(true);
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
        if (last) setProgressText(last.message);
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
      setRescanning(false);
    }
  };

  const onRescan = () => {
    if (!trackedUrl) {
      showToast("Open the dashboard from a scan (?url=...) to run tests.");
      return;
    }
    runTests(trackedUrl);
  };

  // ----- Derived: header status, filtered/sorted/paginated rows -----

  const open = bugs.filter((b) => b.status !== "resolved" && b.status !== "ignored");
  const worst = ["high", "medium", "low"].find((s) => open.some((b) => b.severity === s));

  let filtered = bugs.slice();
  if (statusFilter !== "all") filtered = filtered.filter((b) => b.status === statusFilter);
  if (search.trim()) {
    const q = search.trim().toLowerCase();
    filtered = filtered.filter((b) => b.title.toLowerCase().includes(q) || b.page.toLowerCase().includes(q));
  }
  if (sort === "priority") filtered.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity]);
  else filtered.sort((a, b) => new Date(b.detected) - new Date(a.detected));

  const totalPages = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, totalPages);
  const pageItems = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  // ----- Handlers -----

  const resetToFirstPage = (fn) => (value) => {
    fn(value);
    setPage(1);
  };

  const cycleFilter = () => {
    const next = STATUS_OPTIONS[(STATUS_OPTIONS.indexOf(statusFilter) + 1) % STATUS_OPTIONS.length];
    setStatusFilter(next);
    setPage(1);
  };

  const toggleExpand = (id, type) => {
    setExpanded((ex) => ({ ...ex, [id]: ex[id] === type ? null : type }));
  };

  const changeStatus = (id, status) => {
    setBugs((list) =>
      list.map((b) => {
        if (b.id !== id) return b;
        const updated = { ...b, status };
        saveStatus(updated);
        return updated;
      }),
    );
    setProgressText(null);
  };

  const goToPage = (n) => {
    setPage(n);
    tableWrapRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  };

  const openModal = (bug) => setModal({ bug, visible: true });
  const closeModal = () => setModal((m) => ({ ...m, visible: false }));

  const confirmModal = () => {
    const bug = modal.bug;
    if (!modal.visible || !bug) return;
    setAutomationLogs((logs) => [...logs, { title: bug.title, page: bug.page, time: "Just now" }]);
    if (bug.url) window.open(bug.url, "_blank", "noopener");
    showToast(`Opened ${bug.page}`);
    closeModal();
  };

  return (
    <>
      <Navbar active="dashboard" />

      <div className="dashboard-shell">
        {/* ===== Sidebar ===== */}
        <aside className="sidebar">
          {SIDEBAR.map((item) => (
            <button key={item.view} className={`sidebar-link${view === item.view ? " active" : ""}`} data-view={item.view}
              onClick={() => setView(item.view)}>
              <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">{item.icon}</svg>
              {item.label}
            </button>
          ))}
        </aside>

        <main className="dashboard-main">
          {/* ===== Dashboard View ===== */}
          <section className={`dashboard-view${view === "dashboard" ? " active" : ""}`} id="view-dashboard">
            {/* Hosted App Status Bar */}
            <div className="status-bar">
              <div className="status-bar-left">
                <span className="app-url" id="tracked-url">
                  {!loaded ? "Loading…" : trackedUrl ? displayUrl(trackedUrl) : "No scans yet"}
                </span>
                <button className="btn btn-cream btn-sm" id="rescan-btn" disabled={rescanning} onClick={onRescan}>Re-Scan</button>
              </div>
              <div className="status-bar-right">
                <span>Last scanned: <strong id="last-scanned-text">{!loaded ? "…" : progressText ?? relativeTime(lastScannedAt)}</strong></span>
                <span className="status-line">
                  Status:{" "}
                  {loaded ? (
                    <span className={`status-dot ${worst || "resolved"}`} id="status-dot"
                      title={worst ? `Open ${worst}-severity bugs` : "No open bugs"}></span>
                  ) : (
                    <span className="status-dot" id="status-dot"></span>
                  )}
                </span>
                <a href="scan.html" className="scan-another">Scan another URL</a>
              </div>
            </div>

            {/* Summary Stats */}
            <StatsStrip bugs={bugs} />

            {/* Filter & Sort Bar */}
            <div className="filter-bar">
              <div className="filter-controls">
                <select id="sort-select" value={sort} onChange={(e) => resetToFirstPage(setSort)(e.target.value)}>
                  <option value="priority">Sort by Priority</option>
                  <option value="recency">Sort by Recency</option>
                </select>
                <select id="status-filter" value={statusFilter} onChange={(e) => resetToFirstPage(setStatusFilter)(e.target.value)}>
                  <option value="all">All statuses</option>
                  <option value="open">Open</option>
                  <option value="in-progress">In Progress</option>
                  <option value="resolved">Resolved</option>
                  <option value="ignored">Ignored</option>
                </select>
                <button className="btn btn-chip" id="filter-toggle-btn" onClick={cycleFilter}>Filter</button>
              </div>
              <div className="search-box">
                <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="11" cy="11" r="7" /><line x1="21" y1="21" x2="16.65" y2="16.65" /></svg>
                <input type="text" id="search-input" placeholder="Search bugs or pages…" value={search}
                  onChange={(e) => resetToFirstPage(setSearch)(e.target.value)} />
              </div>
            </div>

            {/* Bug Table */}
            <div className="table-wrap" ref={tableWrapRef}>
              <table className="bug-table">
                <thead>
                  <tr>
                    <th style={{ width: "38%" }}>Issue</th>
                    <th className="center">RCA</th>
                    <th className="center">Fix</th>
                    <th className="center">Severity</th>
                    <th className="center">Status</th>
                    <th className="center">Action</th>
                  </tr>
                </thead>
                <tbody id="bug-table-body">
                  {pageItems.map((bug) => {
                    const expandedType = expanded[bug.id];
                    return (
                      <Fragment key={bug.id}>
                        <tr className="bug-row" data-id={bug.id}>
                          <td>
                            <div className="bug-title-cell">
                              <div className="bug-thumb">
                                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><rect x="3" y="3" width="18" height="14" rx="2" /><path d="M3 13l4-4 4 4 6-6 4 4" /></svg>
                              </div>
                              <div>
                                <div className="bug-title">{bug.title}</div>
                                <div className="bug-meta">{bug.page} &middot; {bug.detectedLabel}</div>
                              </div>
                            </div>
                          </td>
                          <td className="center">
                            <button className="btn btn-chip btn-sm expand-btn" onClick={() => toggleExpand(bug.id, "rca")}>RCA</button>
                          </td>
                          <td className="center">
                            <button className="btn btn-chip btn-sm expand-btn" onClick={() => toggleExpand(bug.id, "fix")}>Fix</button>
                          </td>
                          <td className="center"><SeverityBadge sev={bug.severity} /></td>
                          <td className="center">
                            <select className="status-select" value={bug.status} onChange={(e) => changeStatus(bug.id, e.target.value)}>
                              <option value="open">Open</option>
                              <option value="in-progress">In Progress</option>
                              <option value="resolved">Resolved</option>
                              <option value="ignored">Ignored</option>
                            </select>
                          </td>
                          <td className="center">
                            <button className="btn btn-dark btn-sm go-to-site-btn" onClick={() => openModal(bug)}>
                              <RobotIcon width="14" height="14" />
                              Go to Site
                            </button>
                          </td>
                        </tr>
                        <tr className="expand-detail">
                          <td colSpan="6">
                            <div className={`expand-detail-inner${expandedType ? " open" : ""}`}>
                              {expandedType === "rca" && <><h5>Root Cause Analysis</h5><p>{bug.rca}</p></>}
                              {expandedType === "fix" && <><h5>Suggested Fix</h5><p>{bug.fix}</p></>}
                            </div>
                          </td>
                        </tr>
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              <div className="empty-state" id="empty-state" style={{ display: filtered.length === 0 ? "block" : "none" }}>
                <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><circle cx="12" cy="12" r="9" /><path d="M8 12h8M8 16h5M8 8h3" /></svg>
                <h3>{empty.title}</h3>
                <p>{empty.text}</p>
              </div>
            </div>

            {/* Pagination */}
            <div className="pagination" id="pagination">
              {filtered.length > PAGE_SIZE && (
                <>
                  <button className="page-btn" id="page-prev" disabled={currentPage === 1} onClick={() => goToPage(currentPage - 1)}>&#8592;</button>
                  {Array.from({ length: totalPages }, (_, i) => i + 1).map((n) => (
                    <button key={n} className={`page-btn${n === currentPage ? " active" : ""}`} onClick={() => goToPage(n)}>{n}</button>
                  ))}
                  <button className="page-btn" id="page-next" disabled={currentPage === totalPages} onClick={() => goToPage(currentPage + 1)}>&#8594;</button>
                </>
              )}
            </div>
          </section>

          {/* ===== Bug Reports View ===== */}
          <section className={`dashboard-view${view === "reports" ? " active" : ""}`} id="view-reports">
            <div className="panel-card">
              <h2>Bug Reports</h2>
              <p>A running history of every bug BugOps has surfaced across your scans.</p>
              <div className="log-list" id="reports-list">
                {bugs.map((bug) => (
                  <div className="log-item" key={bug.id}>
                    <span className={`status-dot ${bug.severity}`}></span>
                    <span className="log-text">{bug.title} &middot; {bug.page}</span>
                    <span className="log-time">{bug.detectedLabel}</span>
                  </div>
                ))}
              </div>
            </div>
          </section>

          {/* ===== Automation Logs View ===== */}
          <section className={`dashboard-view${view === "logs" ? " active" : ""}`} id="view-logs">
            <div className="panel-card">
              <h2>Automation Logs</h2>
              <p>Every time you confirm "Go to Site", the action is recorded here.</p>
              <div className="log-list" id="automation-log-list">
                {automationLogs.length === 0 ? (
                  <div className="empty-state" style={{ padding: "32px 12px" }}>
                    <h3>No automation runs yet</h3>
                    <p>Confirm "Go to Site" on a bug to log an automated run here.</p>
                  </div>
                ) : (
                  automationLogs
                    .slice()
                    .reverse()
                    .map((log, i) => (
                      <div className="log-item" key={automationLogs.length - i}>
                        <RobotIcon className="icon" />
                        <span className="log-text">Automated reproduction triggered for "{log.title}" on {log.page}</span>
                        <span className="log-time">{log.time}</span>
                      </div>
                    ))
                )}
              </div>
            </div>
          </section>

          {/* ===== Settings View ===== */}
          <section className={`dashboard-view${view === "settings" ? " active" : ""}`} id="view-settings">
            <div className="panel-card">
              <h2>Settings</h2>
              <p>Manage how BugOps scans and notifies you.</p>
              <div className="settings-form">
                {SETTINGS.map((s) => (
                  <div className="settings-row" key={s.key}>
                    <div>
                      <div className="label">{s.label}</div>
                      <div className="hint">{s.hint}</div>
                    </div>
                    <button className={`switch${settings[s.key] ? " on" : ""}`} data-setting={s.key}
                      onClick={() => setSettings((st) => ({ ...st, [s.key]: !st[s.key] }))}></button>
                  </div>
                ))}
              </div>
            </div>
          </section>
        </main>
      </div>

      {/* ===== Confirm-navigate Modal ===== */}
      <div className={`modal-overlay${modal.visible ? " visible" : ""}`} id="confirm-modal"
        onClick={(e) => e.target === e.currentTarget && closeModal()}>
        <div className="modal-card">
          <div className="modal-icon">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" width="22" height="22"><rect x="3" y="11" width="18" height="10" rx="2" /><circle cx="12" cy="5" r="2" /><line x1="12" y1="7" x2="12" y2="11" /><line x1="8" y1="16" x2="8" y2="16" /><line x1="16" y1="16" x2="16" y2="16" /></svg>
          </div>
          <h3>Confirm automated action</h3>
          <p>BugOps will open <span className="modal-url" id="modal-url">{modal.bug?.page}</span> and attempt to reproduce this bug automatically. This visits your live site.</p>
          <div className="modal-actions">
            <button className="btn btn-outline btn-sm" id="modal-cancel" onClick={closeModal}>Cancel</button>
            <button className="btn btn-dark btn-sm" id="modal-confirm" onClick={confirmModal}>Confirm &amp; Go to Site</button>
          </div>
        </div>
      </div>

      {/* ===== Toast ===== */}
      <div className={`toast${toast.visible ? " visible" : ""}`} id="toast">
        <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12" /></svg>
        <span id="toast-text">{toast.text}</span>
      </div>
    </>
  );
}

mount(Dashboard, { requireAuth: true });
