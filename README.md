#  BugOps

**AI-powered bug detection for live web apps.** Paste in a URL, and BugOps crawls your site like a real user, flags issues, and hands you a prioritized list of bugs with root causes and suggested fixes.


![BugOps landing page](screenshots/landing.png)

---

##  Features

- **Autonomous crawling agent**: follows an observe → plan → act loop, visiting links page by page (with depth tracking and an action queue).
- **Bug detection** across four categories:
  -  **Broken links**: 404s, dead redirects, missing assets
  -  **Console errors**: JS exceptions and failed network calls
  -  **UI / layout issues**: overlaps, overflow, responsive breaks
  -  **Performance issues**: slow loads, large payloads, bottlenecks
  -  **Logical errors**: behavior that doesn't work as expected (e.g. actions leading to the wrong screen or a broken state), with suggested fixes
- **Severity ranking**: bugs are tagged `high`, `medium` or `low`.
- **Root cause + suggested fix** for every bug found.
- **Live scan log**: watch the agent work in real time, and stop a scan at any time.
- **Action timeline**: a full table of what the agent did and whether each step worked or broke.
- **User accounts & dashboard**: log in, view past scans, and jump back into previous results.
- **LLM-assisted evaluation and ranking** (Gemini), with a graceful fallback to signal-based detection when no API key is set.

---

##  Screenshots

### Scan your app
Enter a live URL and kick off a scan. The page also lists what BugOps checks for.

![Scan page](screenshots/scan-page.png)

### Live analysis
A streaming log shows each `observe`, `plan`, `act`, `warning` and `bug` event, along with summary stats (actions, screens, bugs by severity, time, LLM calls).

![Analysis results](screenshots/analysis-results.png)

### Bugs found
Each bug includes its severity, error message, where it happened, the root cause, and a suggested fix.

![Bugs found](screenshots/bugs-found.png)

### What the agent did
A step-by-step record of every action the crawler took and its outcome.

![Agent actions](screenshots/agent-actions.png)

### Recently scanned
Jump back into any previous scan's results from the home page.

![Recently scanned](screenshots/recently-scanned.png)

---

##  Tech Stack

| Layer | Technology |
|-------|-----------|
| Frontend | React 18, JavaScript, Vite 5 |
| Backend API | Node.js (ES modules), Express 5 |
| Browser automation | Playwright with Chromium |
| Agent workflow | LangGraph.js |
| Database | MongoDB 7, using the official Node.js driver |
| Cache | Redis 7 for optional scan-analysis caching |
| AI | Google Gemini API |
| Authentication | Bearer-token sessions; passwords are hashed with Node.js `scrypt` and sessions are stored in MongoDB |
| Runtime / serving | Docker Compose and Nginx |

---

##  Project Structure

```
Fullstack-Project-Sem-5/
├── backend/
│   ├── src/
│   │   ├── crawler/             # LangGraph crawl workflow, browser session, and page actions
│   │   ├── llm/                 # Gemini API integration
│   │   ├── testlib/
│   │   │   └── templates/       # Reusable browser-based QA checks
│   │   ├── auth.js              # Signup, login, and bearer-token sessions
│   │   ├── db.js                # MongoDB connection and indexes
│   │   └── server.js            # Express API
│   ├── .env.example             # Backend configuration template
│   ├── Dockerfile
│   ├── package-lock.json
│   └── package.json
├── frontend/
│   ├── src/
│   │   ├── components/          # Shared React UI components
│   │   ├── lib/                 # Frontend helpers and API/auth utilities
│   │   ├── pages/               # Home, scan, login, signup, and dashboard pages
│   │   └── styles/              # Application styles
│   ├── *.html                   # Vite entry points for each page
│   ├── Dockerfile
│   ├── nginx.conf
│   ├── package-lock.json
│   └── package.json
├── screenshots/                 # README screenshots
├── docker-compose.yml           # Frontend, backend, MongoDB, and Redis services
└── README.md
```

---

##  Getting Started

### Prerequisites

- Node.js 18+ and npm
- A Google Gemini API key (optional but recommended)

### 1. Clone the repo

```bash
git clone https://github.com/ShrikaNeeharikaC/Fullstack-Project-Sem-5.git
cd Fullstack-Project-Sem-5
git checkout react-final
```

### 2. Install dependencies

```bash
# frontend
cd client
npm install

# backend
cd ../server
npm install
```

### 3. Configure environment variables

Create a `.env` file in the backend folder:

```env
GEMINI_API_KEY=your_gemini_api_key
PORT=5000
# add your DB connection string, JWT secret, etc.
```

> Without `GEMINI_API_KEY`, BugOps still runs, but falls back to signals only (no LLM evaluation or ranking). The scan log will show warnings like `LLM evaluation failed, using signals only`.

### 4. Run the app

```bash
# backend
cd server
npm start

# frontend (new terminal)
cd client
npm start
```

Open **http://localhost:3000** in your browser.

## CI-triggered deployed application scans

BugOps supports automated scans after an application deployment. The CI API uses a separate backend key and does not replace the normal user session tokens.

### Backend configuration (Render)

In the BugOps backend service on Render, add `CI_SCAN_API_KEY` as a secret environment variable. Generate a long random value (for example, `openssl rand -hex 32`) and use the same value in GitHub Actions. Do not commit the real value or print it in logs. The backend environment example contains only a placeholder. Set the normal `MONGODB_URI` and other backend settings as usual. After saving environment changes, redeploy the backend.

### GitHub Actions configuration

The workflow at `.github/workflows/bugops-ci-scan.yml` runs when GitHub reports a successful `deployment_status`, and it can also be started manually from the Actions tab. This repository does not contain a deployment workflow, so the scan runs from the GitHub deployment completion event rather than assuming that a push deployed the target. A deployment integration must emit GitHub deployment status events for the automatic trigger to run.

In repository **Settings → Secrets and variables → Actions**, add these repository variables:

- `BUGOPS_API_URL`: the public HTTPS URL of the deployed BugOps backend, without `/api` (for example, `https://bugops-api.example.com`).
- `BUGOPS_TARGET_URL`: the public HTTPS URL of the application to scan.

Add this repository secret:

- `CI_SCAN_API_KEY`: the same random key set on the backend.

The workflow posts `{"targetUrl":"..."}` to `POST /api/scan` using `Authorization: Bearer <CI_SCAN_API_KEY>`, then polls `GET /api/scan/<runId>`. It times out after 30 minutes, fails on transport/auth/response errors or unsuccessful scans, and fails when the completed response reports newly discovered high-severity findings. Its log prints the run ID and bug counts, never the key.

### Baselines and result behavior

CI runs reuse BugOps's Playwright/LangGraph crawler and save reports in the existing scans collection. The baseline consists of up to 20 most recent completed CI or user crawl reports for the same normalized target URL. Findings are compared with a stable SHA-256 fingerprint derived from normalized bug title and affected URL, not database IDs. Previously known high-severity bugs therefore do not fail later runs. With no baseline, every high-severity finding in the first completed scan is new and fails that run; the completed report then becomes a baseline, so an unchanged finding is treated as known on later runs. Medium and low findings are included in `totalBugsFound` but do not fail the pipeline. Failed or incomplete scans always return `ciStatus: "fail"`.

The final response includes `runId`, `scanStatus`, `totalBugsFound`, `newlyDiscoveredHighSeverityBugs`, `baselineExists`, and `ciStatus`. CI-triggered scans skip interactive login prompts; deployments that require authentication should be exposed through a safe, unauthenticated test route or scanned with an appropriately designed test account flow.

### Troubleshooting

- **401 Unauthorized:** confirm the backend secret and GitHub secret match, and that the request uses the Bearer header.
- **400 target URL rejected:** use a public HTTP(S) URL. Localhost, private, loopback, link-local, internal hostnames, and URLs resolving to any such address are blocked. The crawler checks redirects and requested resources too.
- **No baseline:** the first scan flags all high-severity findings. Its completed report becomes the baseline for later scans, even when its CI result failed because of new findings.
- **Timeout or failed scan:** check the GitHub Actions logs and backend logs for availability, MongoDB connectivity, Playwright/Chromium setup, and LLM provider configuration. A failed/incomplete run cannot pass CI.

---

##  How It Works

1. **Submit a URL** on the Scan page.
2. The agent **observes** the current page and collects signals (console errors, failed requests, layout problems).
3. It **plans** by queueing new links and actions to try.
4. It **acts** by visiting each page or link and checking the outcome.
5. Built-in **test templates** run checks and combine their results with browser signals such as JavaScript errors and failed requests. Gemini can optionally help categorize elements, review selected results for logic issues, and suggest fixes; template checks and hints still work without it.
6. Results are saved to your **dashboard** so you can revisit them later.

---

##  Roadmap

- [ ] Smarter, code-aware fix suggestions (replace generic "inspect the console" advice)
- [ ] Form-filling and authenticated-flow scanning
- [ ] Export reports (PDF / CSV)
- [ ] Scheduled and recurring scans
- [ ] Scan comparison across runs

---

