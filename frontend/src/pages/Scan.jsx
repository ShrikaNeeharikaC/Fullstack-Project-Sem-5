// Scan page: recently-scanned list + scan submission -> live LangGraph crawl -> report
import { useEffect, useRef, useState } from "react";
import Navbar from "../components/Navbar.jsx";
import Footer from "../components/Footer.jsx";
import { apiFetch } from "../lib/auth.js";
import { dashboardLink, displayUrl, relativeTime } from "../lib/format.js";
import { mount } from "../lib/mount.jsx";

function isLikelyUrl(value) {
  const trimmed = value.trim();
  if (!trimmed) return false;
  // Accept "example.com", "www.example.com", "https://example.com/path",
  // "localhost:5173", "http://host.docker.internal:5173"
  return /^(https?:\/\/)?(localhost|[a-z0-9-]+(\.[a-z0-9-]+)+)(:\d{1,5})?([\/?#].*)?$/i.test(trimmed);
}

// Local dev servers rarely have HTTPS, so default those to http://.
const LOCAL_HOST = /^(localhost|127\.0\.0\.1|host\.docker\.internal)([:\/?#]|$)/i;

const POLL_MS = 1500;

const STOP_REASONS = {
  max_actions: "action limit reached",
  max_states: "screen limit reached",
  time_limit: "time limit reached",
  no_new_screens: "no new screens found recently",
  nothing_left_to_explore: "everything reachable was explored",
  stopped_by_user: "stopped by you",
};

// ---------- Recently scanned ----------

// Real scans only: every URL scanned before (Scan page or dashboard Re-Scan),
// most recent first, read from the backend's saved results.
function RecentScans({ scans }) {
  if (scans === undefined) return <div className="recent-grid" id="recent-grid"></div>;
  if (scans === null) {
    return (
      <div className="recent-grid" id="recent-grid">
        <div className="recent-empty">Can't reach the BugOps backend, so past scans can't be shown. Start it with <code>npm start</code> in the backend folder.</div>
      </div>
    );
  }
  if (scans.length === 0) {
    return (
      <div className="recent-grid" id="recent-grid">
        <div className="recent-empty">No apps scanned yet. Run your first scan above to see results here.</div>
      </div>
    );
  }
  return (
    <div className="recent-grid" id="recent-grid">
      {scans.slice(0, 6).map((scan) => {
        const b = scan.bugs;
        const worst = b.high ? "high" : b.medium ? "medium" : b.low ? "low" : "resolved";
        return (
          <a className="recent-card" href={dashboardLink(scan.url)} key={scan.url}>
            <div className="status-dot-row">
              <span className={`status-dot ${worst}`}></span>
              <span className="timestamp">Last scanned {relativeTime(scan.lastScanned, { lowercase: true })}</span>
            </div>
            <span className="url">{displayUrl(scan.url)}</span>
            <span className="bug-count">{b.total} bug{b.total === 1 ? "" : "s"} found</span>
            <span className="view-results">View Results &nbsp;&#8594;</span>
          </a>
        );
      })}
    </div>
  );
}

// ---------- Agent question ----------

// The agent's pending question (risky action / form / login) with one button
// per option. Keyed by the question, so its local state resets when it changes.
function CrawlQuestion({ question, scanId }) {
  const [sending, setSending] = useState(false);
  const [error, setError] = useState("");
  const passwordRef = useRef(null);
  const usernameRef = useRef(null);

  // The login question's "Log in with my account" option needs the
  // username/password; they go straight to the backend with the answer.
  const login = question.options.find((o) => o.needsCredentials);

  const send = async (body) => {
    setSending(true);
    setError("");
    try {
      const res = await apiFetch(`/api/scan/${scanId}/answer`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!data.success) throw new Error(data.error || "Could not send the answer");
    } catch (err) {
      console.error(err);
      setError(err.message);
      setSending(false);
    }
  };

  const onLogin = (e) => {
    e.preventDefault();
    send({
      answer: login.value,
      credentials: { username: usernameRef.current.value.trim(), password: passwordRef.current.value },
    });
    passwordRef.current.value = "";
  };

  return (
    <div id="crawl-question">
      <strong>{question.question}</strong>
      <p>Action: {question.action.label}</p>
      {question.riskReason && <p>Why it was flagged: {question.riskReason}</p>}
      {question.action.fields && (
        <ul>
          {question.action.fields.map((f, i) => (
            <li key={i}>{f.label || f.placeholder || f.name || f.type} <em>({f.type || f.tag})</em></li>
          ))}
        </ul>
      )}
      {login && (
        <form className="q-login" autoComplete="off" onSubmit={onLogin}>
          <input type="text" name="username" placeholder="Email or username" required ref={usernameRef} />
          <input type="password" name="password" placeholder="Password" required autoComplete="new-password" ref={passwordRef} />
          <button type="submit" className="btn btn-dark btn-sm" disabled={sending}>{login.label}</button>
          <p className="q-hint">Used only to log in during this scan and later Re-Scans of this site. Not saved to disk.</p>
        </form>
      )}
      <div className="q-options">
        {question.options
          .filter((o) => !o.needsCredentials)
          .map((o) => (
            <button type="button" className="btn btn-dark btn-sm" key={o.value} disabled={sending}
              onClick={() => send({ answer: o.value })}>
              {o.label}
            </button>
          ))}
      </div>
      <p className="q-error" hidden={!error}>{error}</p>
    </div>
  );
}

// ---------- Report ----------

const List = ({ items }) => (
  <ul>{(items || []).map((a, i) => <li key={i}>{a}</li>)}</ul>
);

// Landing page analysis (the original single-page prompt's JSON).
function Analysis({ analysis }) {
  const el = analysis.elements;
  return (
    <>
      {analysis.page && (
        <>
          <h3>Page Overview</h3>
          <ul>
            <li><strong>URL:</strong> {analysis.page.url || "N/A"}</li>
            <li><strong>Title:</strong> {analysis.page.title || "N/A"}</li>
            <li><strong>Purpose:</strong> {analysis.page.purpose || "N/A"}</li>
          </ul>
        </>
      )}
      {analysis.layout && (
        <>
          <h3>Layout</h3>
          <ul>
            <li><strong>Sections:</strong> {(analysis.layout.sections || []).join(", ")}</li>
            <li><strong>Navigation:</strong> {(analysis.layout.navigation || []).join(", ")}</li>
          </ul>
        </>
      )}
      {el && (
        <>
          <h3>Elements</h3>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: "10px" }}>
            <div><strong>Buttons:</strong> {(el.buttons || []).length}</div>
            <div><strong>Inputs:</strong> {(el.inputs || []).length}</div>
            <div><strong>Forms:</strong> {(el.forms || []).length}</div>
            <div><strong>Links:</strong> {(el.links || []).length}</div>
            <div><strong>Images:</strong> {(el.images || []).length}</div>
            <div><strong>Interactive:</strong> {(el.interactive_elements || []).length}</div>
          </div>
        </>
      )}
      {analysis.possible_actions?.length > 0 && <><h3>Possible Actions</h3><List items={analysis.possible_actions} /></>}
      {analysis.potential_issues?.ui_ux?.length > 0 && <><h3>Potential UI/UX Issues</h3><List items={analysis.potential_issues.ui_ux} /></>}
      {analysis.potential_issues?.accessibility?.length > 0 && <><h3>Accessibility Issues</h3><List items={analysis.potential_issues.accessibility} /></>}
      {analysis.observations?.length > 0 && <><h3>Observations</h3><List items={analysis.observations} /></>}
    </>
  );
}

function Report({ report }) {
  if (!report) return <p>No report was produced.</p>;
  const s = report.stats;
  return (
    <>
      <p><a className="btn btn-dark btn-sm" href={dashboardLink(report.startUrl)}>View in dashboard &#8594;</a></p>
      <p>Stopped because: <strong>{STOP_REASONS[report.stopReason] || report.stopReason}</strong></p>
      <div className="crawl-stats">
        <div><strong>{s.actions}</strong>actions</div>
        <div><strong>{s.screens}</strong>screens</div>
        <div><strong>{s.bugs.total}</strong>bugs</div>
        <div><strong>{s.bugs.high}</strong>high</div>
        <div><strong>{s.bugs.medium}</strong>medium</div>
        <div><strong>{s.bugs.low}</strong>low</div>
        <div><strong>{s.activeSeconds}s</strong>time</div>
        <div><strong>{s.llmCalls}</strong>LLM calls</div>
      </div>

      <h3>Bugs found</h3>
      {report.bugs.length ? (
        report.bugs.map((b, i) => (
          <div className={`bug-item ${b.severity}`} key={i}>
            <h4>[{b.severity}] {b.title}</h4>
            <p>{b.description}</p>
            <p><strong>Where:</strong> {b.url}, after: {b.action}</p>
            {b.rca && <p><strong>Root cause:</strong> {b.rca}</p>}
            {b.suggested_fix && <p><strong>Suggested fix:</strong> {b.suggested_fix}</p>}
          </div>
        ))
      ) : (
        <p>No bugs found in the explored screens.</p>
      )}

      <h3>What the agent did</h3>
      <div className="crawl-table-wrap">
        <table className="crawl-table">
          <tbody>
            <tr><th>#</th><th>Action</th><th>Outcome</th><th>Result</th></tr>
            {report.actions.map((a, i) => (
              <tr key={i}>
                <td>{a.n}</td>
                <td>{a.label}</td>
                <td>{a.outcome}{a.newScreen ? " (new screen)" : ""}</td>
                <td>{a.error || a.summary || a.urlAfter}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {report.skipped.length > 0 && (
        <>
          <h3>Skipped</h3>
          <ul>{report.skipped.map((x, i) => <li key={i}>{x.label}: {x.reason}</li>)}</ul>
        </>
      )}

      {report.landing && !report.landing.error && (
        <>
          <h2 style={{ marginTop: "30px" }}>Landing page analysis</h2>
          <Analysis analysis={report.landing} />
        </>
      )}
      {report.landing?.error && <p>Landing page analysis unavailable: {report.landing.error}</p>}
    </>
  );
}

// ---------- Page ----------

const CHECKS = [
  {
    title: "Broken Links",
    text: "404s, dead redirects & missing assets",
    icon: (
      <>
        <path d="M10 13a5 5 0 0 0 7.07 0l2.83-2.83a5 5 0 0 0-7.07-7.07L11 5" />
        <path d="M14 11a5 5 0 0 0-7.07 0L4.1 13.83a5 5 0 0 0 7.07 7.07L13 19" />
      </>
    ),
  },
  {
    title: "Console Errors",
    text: "JS exceptions & failed network calls",
    icon: (
      <>
        <polyline points="4 17 10 11 4 5" />
        <line x1="12" y1="19" x2="20" y2="19" />
      </>
    ),
  },
  {
    title: "UI / Layout Issues",
    text: "Overlaps, overflow & responsive breaks",
    icon: (
      <>
        <rect x="3" y="4" width="18" height="16" rx="2" />
        <line x1="3" y1="10" x2="21" y2="10" />
        <line x1="9" y1="10" x2="9" y2="20" />
      </>
    ),
  },
  {
    title: "Performance Issues",
    text: "Slow loads, large payloads & bottlenecks",
    icon: (
      <>
        <polyline points="3 17 9 11 13 15 21 6" />
        <polyline points="14 6 21 6 21 13" />
      </>
    ),
  },
];

function Scan() {
  const [url, setUrl] = useState("");
  const [scanError, setScanError] = useState("");
  const [busy, setBusy] = useState(false);
  const [recent, setRecent] = useState(undefined); // undefined = loading, null = backend unreachable

  // Live crawl panel
  const [panel, setPanel] = useState(null); // { url, startedAt } once a scan starts
  const [status, setStatus] = useState("Starting…");
  const [events, setEvents] = useState([]);
  const [question, setQuestion] = useState(null);
  const [stopDisabled, setStopDisabled] = useState(false);
  const [report, setReport] = useState(undefined); // undefined = no report yet
  const [rawJson, setRawJson] = useState("");

  const scanIdRef = useRef(null);
  const pollTimer = useRef(null);
  const inputRef = useRef(null);
  const panelRef = useRef(null);
  const logRef = useRef(null);

  const loadRecent = async () => {
    try {
      const res = await apiFetch(`/api/scans`);
      setRecent((await res.json()).scans || []);
    } catch (err) {
      setRecent(null);
    }
  };

  useEffect(() => {
    loadRecent();
    return () => clearTimeout(pollTimer.current);
  }, []);

  // New scan started: bring the live panel into view.
  useEffect(() => {
    if (panel) panelRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [panel]);

  // Keep the log scrolled to the newest event.
  useEffect(() => {
    if (logRef.current) logRef.current.scrollTop = logRef.current.scrollHeight;
  }, [events.length]);

  const finishScan = () => {
    setStopDisabled(true);
    setQuestion(null);
    setBusy(false);
  };

  const pollScan = async () => {
    clearTimeout(pollTimer.current);
    let scan;
    try {
      const res = await apiFetch(`/api/scan/${scanIdRef.current}`);
      scan = await res.json();
    } catch (err) {
      setStatus("Lost connection to backend, retrying...");
      pollTimer.current = setTimeout(pollScan, POLL_MS * 2);
      return;
    }
    if (!scan.success) {
      setStatus(scan.error || "Scan not found");
      finishScan();
      return;
    }

    setEvents(scan.events);
    setQuestion(scan.question || null);

    if (scan.status === "running") {
      const acts = scan.events.filter((e) => e.type === "act").length;
      setStatus(`Crawling... ${acts} action${acts === 1 ? "" : "s"} so far`);
    } else if (scan.status === "waiting_for_user") {
      setStatus("Paused: the agent needs your decision below");
    } else if (scan.status === "done") {
      setStatus("Scan complete");
      finishScan();
      setReport(scan.report ?? null);
      setRawJson(JSON.stringify(scan.report, null, 2));
      loadRecent();
      return;
    } else if (scan.status === "error") {
      setStatus(`Scan failed: ${scan.error}`);
      finishScan();
      return;
    }
    pollTimer.current = setTimeout(pollScan, POLL_MS);
  };

  // Starts a LangGraph crawl on the backend, then polls it until it finishes.
  const runScanSequence = async (value) => {
    const fullUrl = /^https?:\/\//i.test(value) ? value : (LOCAL_HOST.test(value) ? "http://" : "https://") + value;

    setBusy(true);
    try {
      const res = await apiFetch(`/api/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: fullUrl }),
      });
      const data = await res.json();
      if (!data.success) {
        setScanError(data.error || "Could not start the scan");
        setBusy(false);
        return;
      }

      scanIdRef.current = data.scanId;
      setStatus("Starting…");
      setEvents([]);
      setQuestion(null);
      setStopDisabled(false);
      setReport(undefined);
      setRawJson("");
      setPanel({ url: fullUrl, startedAt: Date.now() });
      pollScan();
    } catch (err) {
      console.error(err);
      setScanError("Could not connect to backend.");
      setBusy(false);
    }
  };

  const onSubmit = (e) => {
    e.preventDefault();
    const value = url.trim();
    if (!isLikelyUrl(value)) {
      setScanError("Please enter a valid URL, e.g. yourapp.com");
      inputRef.current.focus();
      return;
    }
    setScanError("");
    runScanSequence(value);
  };

  const onStop = async () => {
    if (!scanIdRef.current) return;
    setStopDisabled(true);
    setStatus("Stopping after the current action...");
    await apiFetch(`/api/scan/${scanIdRef.current}/stop`, { method: "POST" }).catch(() => {});
  };

  return (
    <>
      <Navbar />

      <section className="scan-hero container">
        <h1>Scan Your App for Bugs</h1>
        <p>
          Enter your live URL below. We'll crawl every page, flag issues, and hand
          you a prioritized list of bugs with root causes and suggested fixes.
        </p>
      </section>

      <section className="scan-form-wrap container">
        <form id="scan-form" className="scan-form" noValidate onSubmit={onSubmit}>
          <input type="text" id="scan-url" name="url" placeholder="e.g. yourapp.com" autoComplete="off"
            ref={inputRef} value={url} onChange={(e) => setUrl(e.target.value)} />
          <button type="submit" className="btn btn-dark" disabled={busy}>{busy ? "Scanning..." : "SCAN NOW"}</button>
        </form>
        <p className="scan-error" id="scan-error">{scanError}</p>
        <p className="scan-microcopy">
          Takes a few minutes. The agent will ask you before risky actions or filling forms.
        </p>
      </section>

      {/* ===== Results Container ===== */}
      <section
        id="results-container"
        className="container"
        ref={panelRef}
        style={{
          display: panel ? "block" : "none",
          marginTop: "40px",
          padding: "20px",
          background: "#fff",
          borderRadius: "8px",
          boxShadow: "0 4px 12px rgba(0, 0, 0, 0.05)",
        }}
      >
        <div className="section-heading">
          <h2>Analysis Results</h2>
          <p id="result-url-subtitle">{panel ? `Crawling ${panel.url}` : ""}</p>
        </div>
        {/* Live crawl: status + stop, agent questions, progress log */}
        <div id="crawl-live">
          <div className="crawl-status-row">
            <span id="crawl-status">{status}</span>
            <button type="button" id="crawl-stop" className="btn btn-dark btn-sm" disabled={stopDisabled} onClick={onStop}>Stop scan</button>
          </div>
          {question && (
            <CrawlQuestion
              key={question.question + question.action.label}
              question={question}
              scanId={scanIdRef.current}
            />
          )}
          <ol id="crawl-log" ref={logRef}>
            {events.map((e, i) => (
              <li key={i} className={`ev-${e.type}`}>[{e.type}] {e.message}</li>
            ))}
          </ol>
        </div>
        <div id="results-content">{report !== undefined && <Report report={report} />}</div>
        <details style={{ marginTop: "30px", padding: "10px", background: "#f9f9f9", borderRadius: "6px" }}>
          <summary style={{ cursor: "pointer", fontWeight: "bold", marginBottom: "10px" }}>
            Raw JSON Debug View
          </summary>
          <pre
            id="raw-json-view"
            style={{
              overflowX: "auto",
              fontSize: "0.85rem",
              padding: "10px",
              background: "#241a49",
              color: "#fff",
              borderRadius: "4px",
            }}
          >
            {rawJson}
          </pre>
        </details>
      </section>

      {/* ===== What we check for ===== */}
      <section className="section container">
        <div className="section-heading">
          <h2>What we check for</h2>
          <p>A full sweep across the pieces that most often break in production.</p>
        </div>
        <div className="checks-row">
          {CHECKS.map((c) => (
            <div className="check-item" key={c.title}>
              <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8">{c.icon}</svg>
              <h4>{c.title}</h4>
              <p>{c.text}</p>
            </div>
          ))}
        </div>
      </section>

      {/* ===== Recently Scanned ===== */}
      <section className="section container" style={{ paddingTop: 0 }}>
        <div className="section-heading" style={{ textAlign: "left", margin: "0 0 28px" }}>
          <h2 style={{ fontSize: "1.5rem" }}>Recently scanned</h2>
          <p>Jump back into a previous scan's results.</p>
        </div>
        <RecentScans scans={recent} />
      </section>

      <Footer />

      {/* ===== Loading / Transition Overlay ===== */}
      <div className="loading-overlay" id="loading-overlay">
        <div className="loading-card">
          <div className="spinner"></div>
          <h3>Scanning <span id="loading-url">your app</span>&hellip;</h3>
          <div className="progress-steps">
            {["Crawling pages", "Detecting bugs", "Generating fixes"].map((label, i) => (
              <div className="progress-step" data-step={i} key={label}>
                <span className="step-icon">&#8226;</span> {label}
              </div>
            ))}
          </div>
          <div className="progress-bar-track">
            <div className="progress-bar-fill" id="progress-bar-fill"></div>
          </div>
        </div>
      </div>
    </>
  );
}

mount(Scan, { requireAuth: true });
