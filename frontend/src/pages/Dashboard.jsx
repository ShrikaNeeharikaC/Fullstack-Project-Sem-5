// Dashboard: bug table with filter/sort/search/pagination/expand/status/automation.
// Rows come from the backend's saved scans (crawler + test library); there is
// no demo data.
import { Fragment, useEffect, useRef, useState } from "react";
import Navbar from "../components/Navbar.jsx";
import { apiFetch } from "../lib/auth.js";
import { displayUrl, relativeTime } from "../lib/format.js";
import {
  REPO_FORMAT,
  confidenceLabel,
  connectGithub,
  createIssue,
  disconnectGithub,
  fetchScreenshotUrl,
  fetchSource,
  ticketView,
} from "../lib/github.js";
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

// Screenshot and likely source location of one bug, loaded when its details open.
function BugEvidence({ bug, trackedUrl, github }) {
  const [shot, setShot] = useState({ loading: true, url: null, error: null });
  const [source, setSource] = useState({ loading: false, data: null, error: null });

  useEffect(() => {
    let objectUrl = null;
    let alive = true;
    fetchScreenshotUrl(apiFetch, bug, trackedUrl)
      .then((url) => {
        objectUrl = url;
        if (alive) setShot({ loading: false, url, error: null });
        else if (url) URL.revokeObjectURL(url);
      })
      .catch((err) => alive && setShot({ loading: false, url: null, error: err.message }));
    return () => {
      alive = false;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [bug.key, trackedUrl]);

  useEffect(() => {
    if (!github.connected) return;
    let alive = true;
    setSource({ loading: true, data: null, error: null });
    fetchSource(apiFetch, bug, trackedUrl)
      .then((data) => alive && setSource({ loading: false, data, error: null }))
      .catch((err) => alive && setSource({ loading: false, data: null, error: err.message }));
    return () => {
      alive = false;
    };
  }, [bug.key, trackedUrl, github.connected, github.repo, github.ref]);

  const loc = source.data?.location;
  return (
    <div className="bug-evidence">
      <div className="evidence-shot">
        <h5>Screenshot</h5>
        {shot.loading ? (
          <p className="evidence-muted">Loading…</p>
        ) : shot.url ? (
          <a href={shot.url} target="_blank" rel="noopener noreferrer" title="Open full size">
            <img src={shot.url} alt={`Screenshot when "${bug.title}" happened`} />
          </a>
        ) : (
          <p className="evidence-muted">{shot.error || "No screenshot was recorded for this bug."}</p>
        )}
      </div>
      <div className="evidence-source">
        <h5>Likely source location</h5>
        {!github.connected ? (
          <p className="evidence-muted">Connect a GitHub repository in Settings to locate this bug in the code.</p>
        ) : source.loading ? (
          <p className="evidence-muted">Searching {github.repo}…</p>
        ) : source.error ? (
          <p className="ticket-error">{source.error}</p>
        ) : loc && loc.status !== "unidentified" ? (
          <>
            <p>
              <a className="ticket-link" href={loc.sourceCodeUrl} target="_blank" rel="noopener noreferrer">
                {loc.sourceFile}:{loc.sourceLine}
              </a>
              {loc.sourceFunction && <> &middot; <code>{loc.sourceFunction}</code></>}
            </p>
            <p><span className={`confidence ${loc.sourceConfidence}`}>{confidenceLabel(loc)}</span></p>
            <p className="evidence-muted">{loc.sourceReason}</p>
          </>
        ) : (
          <p className="evidence-muted">Not identified. {loc?.sourceReason}</p>
        )}
        {loc?.commit && <p className="evidence-muted">Code version: <code>{loc.commit.slice(0, 7)}</code>{loc.ref ? ` (${loc.ref})` : ""}</p>}
      </div>
    </div>
  );
}

// Create / View GitHub issue for one bug, shown in its expanded details.
function TicketControl({ bug, github, state, onCreate, onConnect }) {
  const v = ticketView({ connected: github.connected, ticket: bug.ticket, pending: state?.pending, error: state?.error });
  return (
    <div className="ticket-bar">
      {v.kind === "view" ? (
        <a className="btn btn-dark btn-sm" href={v.href} target="_blank" rel="noopener noreferrer">{v.label}</a>
      ) : (
        <button className="btn btn-dark btn-sm" disabled={v.disabled} aria-busy={v.kind === "creating"}
          onClick={() => (v.kind === "connect" ? onConnect() : onCreate(bug))}>{v.label}</button>
      )}
      <span className="ticket-note">
        {v.kind === "view" && <>Issue created in {bug.ticket.repo}</>}
        {(v.kind === "create" || v.kind === "creating") && !v.message && <>Creates an issue in {github.repo}</>}
        {v.kind === "connect" && <>Connect a repository to send bugs to GitHub Issues.</>}
      </span>
      {v.message && <span className="ticket-error" role="alert">{v.message}</span>}
    </div>
  );
}

// Settings → GitHub: connect, update or disconnect the user's repository.
function GithubSettings({ github, onChange, showToast }) {
  const [repo, setRepo] = useState(github.repo || "");
  const [token, setToken] = useState("");
  const [ref, setRef] = useState(github.ref || "");
  const [upload, setUpload] = useState(!!github.uploadScreenshots);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    setRepo(github.repo || "");
    setRef(github.ref || "");
    setUpload(!!github.uploadScreenshots);
  }, [github.repo, github.ref, github.uploadScreenshots]);

  const save = async (e) => {
    e.preventDefault();
    setError("");
    if (!REPO_FORMAT.test(repo.trim())) return setError("Enter the repository as owner/repo, e.g. octocat/hello-world.");
    if (!github.connected && !token.trim()) return setError("Paste a GitHub personal access token.");
    setBusy(true);
    try {
      const data = await connectGithub(apiFetch, { repo: repo.trim(), token: token.trim(), ref: ref.trim(), uploadScreenshots: upload });
      setToken("");
      onChange(data);
      showToast(`Connected to ${data.repo}`);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  const disconnect = async () => {
    setBusy(true);
    setError("");
    try {
      await disconnectGithub(apiFetch);
      setToken("");
      onChange({ connected: false, repo: null });
      showToast("GitHub disconnected");
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form className="github-settings" id="github-settings" onSubmit={save}>
      <div className="label">GitHub Issues</div>
      <div className="hint">
        {github.connected ? <>Connected to <strong>{github.repo}</strong>.</> : "Send bugs to a GitHub repository as issues."}{" "}
        Use a <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener noreferrer">fine-grained token</a> with
        access to only that repository and <strong>Issues: Read and write</strong>. Add <strong>Contents: Read</strong> to locate bugs
        in the code, or <strong>Contents: Read and write</strong> to also embed screenshots. It is stored encrypted and never shown again.
      </div>
      <div className="form-group">
        <label htmlFor="github-repo">Repository</label>
        <input id="github-repo" placeholder="owner/repo" value={repo} autoComplete="off" spellCheck="false"
          onChange={(e) => setRepo(e.target.value)} />
      </div>
      <div className="form-group">
        <label htmlFor="github-token">Personal access token</label>
        <input id="github-token" type="password" autoComplete="off" value={token}
          placeholder={github.connected ? "Leave empty to keep the saved token" : "github_pat_…"}
          onChange={(e) => setToken(e.target.value)} />
      </div>
      <div className="form-group">
        <label htmlFor="github-ref">Deployed branch or commit (optional)</label>
        <input id="github-ref" placeholder={github.defaultBranch ? `Default: ${github.defaultBranch} (latest commit)` : "e.g. main or a commit SHA"}
          value={ref} autoComplete="off" spellCheck="false" onChange={(e) => setRef(e.target.value)} />
      </div>
      <label className="checkbox-row">
        <input type="checkbox" checked={upload} onChange={(e) => setUpload(e.target.checked)} />
        <span>
          Embed screenshots in issues. They are uploaded to a separate <code>bugops-screenshots</code> branch of the repository.
          {github.repoPrivate === false && <strong className="ticket-error"> This repository is public: screenshots will be public.</strong>}
        </span>
      </label>
      <span className="field-error" role="alert">{error}</span>
      <div className="github-actions">
        <button className="btn btn-dark btn-sm" type="submit" disabled={busy}>
          {busy ? "Checking…" : github.connected ? "Update" : "Connect repository"}
        </button>
        {github.connected && (
          <button className="btn btn-outline btn-sm" type="button" disabled={busy} onClick={disconnect}>Disconnect</button>
        )}
      </div>
    </form>
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
  const [github, setGithub] = useState({ connected: false, repo: null });
  const [ticketState, setTicketState] = useState({}); // { [bugKey]: { pending, error } }

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
      setGithub(data.github?.connected ? data.github : { connected: false, repo: null });
      setTicketState({});
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

  // Creates (or reuses) the GitHub issue for a bug. One request at a time per bug.
  const createTicketFor = async (bug) => {
    if (ticketState[bug.key]?.pending) return;
    setTicketState((s) => ({ ...s, [bug.key]: { pending: true, error: null } }));
    try {
      const data = await createIssue(apiFetch, bug, trackedUrl);
      const ticket = { status: data.status, repo: data.repo, issueNumber: data.issueNumber, issueUrl: data.issueUrl };
      setBugs((list) => list.map((b) => (b.key === bug.key ? { ...b, ticket } : b)));
      setTicketState((s) => ({ ...s, [bug.key]: { pending: false, error: null } }));
      showToast(data.warning || `${data.reused ? "Issue already exists" : "Issue created"}: #${data.issueNumber}`);
    } catch (err) {
      setTicketState((s) => ({ ...s, [bug.key]: { pending: false, error: err.message } }));
    }
  };

  const goToGithubSettings = () => {
    setView("settings");
    setTimeout(() => document.getElementById("github-repo")?.focus(), 0);
  };

  // Issues belong to a repository, so the rows' issue links change with it.
  const onGithubChange = (next) => {
    setGithub(next);
    if (trackedUrl) loadBugs(trackedUrl);
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
                                <div className="bug-meta">
                                  {bug.page} &middot; {bug.detectedLabel}
                                  {bug.ticket?.status === "created" && bug.ticket.issueUrl && (
                                    <> &middot; <a className="ticket-link" href={bug.ticket.issueUrl} target="_blank" rel="noopener noreferrer">Issue #{bug.ticket.issueNumber}</a></>
                                  )}
                                </div>
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
                              {expandedType && (
                                <>
                                  <BugEvidence bug={bug} trackedUrl={trackedUrl} github={github} />
                                  <TicketControl bug={bug} github={github} state={ticketState[bug.key]}
                                    onCreate={createTicketFor} onConnect={goToGithubSettings} />
                                </>
                              )}
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
                <GithubSettings github={github} onChange={onGithubChange} showToast={showToast} />
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
