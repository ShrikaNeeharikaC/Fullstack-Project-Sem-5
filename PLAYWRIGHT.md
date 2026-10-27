# Playwright in BugOps

This project uses Playwright from the **backend** to open websites in real browser engines, inspect pages, run interactions, and save screenshots and reports. The React frontend does not use Playwright at runtime; it calls backend APIs that start analysis, crawl, or test jobs.

## The main flows

### 1. Single-page analysis

When the app's analysis endpoint is called, `backend/src/browser.js` launches Chrome through Playwright, opens a page, visits the requested URL, and coordinates the analysis. It attaches the test observer, takes a screenshot, captures browser state, extracts page details, sends the screenshot and page structure to the Gemini integration, then closes the browser in a `finally` block.

Related files:

- `backend/src/browser.js` — orchestration and browser lifecycle for one-page analysis.
- `backend/src/pageAnalyzer.js` — uses `page.evaluate()` to read links, buttons, fields, forms, text, and images from the page DOM. `extractFullPageInfo()` adds observed network and browser state.
- `backend/src/screenshot.js` — takes a full-page PNG and returns both its buffer and output path. The current default is `backend/artifacts/screenshot.png` when run from the backend directory.
- `backend/src/llm/gemini.js` — passes the screenshot and extracted page information to the LLM; it is not itself a Playwright module.
- `backend/src/server.js` — exposes the API endpoint that calls `analyzePageWorkflow()`.

### 2. Multi-page crawl

The crawl flow keeps a live Playwright browser open while a LangGraph workflow explores a site. It observes screens, plans interactions, requests approval for risky actions, performs an action, evaluates what changed, and repeats until it reaches a limit or finishes.

Related files:

- `backend/src/crawl.js` — command-line entry point. It starts a crawl and asks for approvals in the terminal.
- `backend/src/crawler/session.js` — creates a per-scan session, launches Chrome, creates the browser context and page, attaches listeners for browser errors/popups, and closes the session. Live Playwright objects are kept in a `Map` keyed by scan ID.
- `backend/src/crawler/graph.js` — defines the crawl workflow and its transitions. It coordinates steps but does not launch a browser itself.
- `backend/src/crawler/nodes.js` — implements crawl steps using the session's Playwright page: observe page state, find controls, click or fill, capture screenshots, and evaluate results.
- `backend/src/crawler/dom.js` — browser-DOM helpers used to describe and locate interactive elements.
- `backend/src/crawler/login.js` — detects and interacts with login forms when the crawl is authorized to use provided credentials.
- `backend/src/crawler/safety.js` — identifies potentially risky actions and helps gate them for approval.
- `backend/src/crawler/scanManager.js` — starts and manages scan jobs; it connects the API/CLI to the graph and live session.
- `backend/src/crawler/config.js` — crawl limits and headless setting, including `CRAWL_HEADLESS`.

### 3. Reusable test runs

The test library inspects a site, chooses applicable checks, performs browser actions, records what changed, and writes test results and screenshots. It uses Chromium for the main run and can open separate Firefox or WebKit browsers for cross-browser checks.

Related files:

- `backend/src/runTests.js` — command-line argument parser for `npm run tests`.
- `backend/src/testlib/jobs.js` — manages test jobs started from the web app.
- `backend/src/testlib/runner.js` — launches the main browser, explores pages, runs the selected templates, and prepares results.
- `backend/src/testlib/context.js` — `TestContext`, the helpers/templates use to reload pages, interact, observe changes, and save DOM and screenshot evidence.
- `backend/src/testlib/observer.js` — records network requests, console messages, cookies, storage, and page state; also provides network guards used during tests.
- `backend/src/testlib/elements.js` and `categorizer.js` — extracts and classifies page controls for test planning.
- `backend/src/testlib/templates/` — individual checks such as forms, navigation, accessibility, broken images, storage security, and cross-browser behavior. `crossBrowser.js` starts Firefox/WebKit where configured.
- `backend/src/testlib/checks.js`, `bugops.js`, and `llmJudge.js` — interpret test observations and format findings. These consume results from Playwright rather than launching browsers.

### 4. Standalone/demo scripts

- `backend/src/script.js` — an older/manual demonstration that launches Chrome, opens `TARGET_URL`, prints page information, optionally performs configured actions, and saves screenshots. It is separate from the app's API workflows.
- `backend/src/screenshot.js` — despite its generic name, this is a helper imported by the single-page workflow, not a standalone browser launcher.

## Playwright concepts used here

- **Browser**: a launched engine such as Chromium. The app generally requests the installed Google Chrome with `channel: "chrome"`.
- **Browser context**: an isolated browser profile for a run. Cookies and storage belong to a context.
- **Page**: a tab. Navigation, DOM evaluation, clicking, filling, and screenshots happen on a page.
- **Headless mode**: runs the browser without a visible window. `headless: false` is useful for debugging; the project controls this through options and environment variables.
- **Browser events**: the crawl and observer code listens for console errors, JavaScript errors, failing HTTP responses, failed requests, popups, and dialogs.

The typical lifecycle is:

```text
launch browser -> create context -> create page -> navigate/interact/observe
               -> save evidence/results -> close browser
```

## Running the Playwright flows

From `backend/` after installing dependencies:

```powershell
npm run crawl -- https://example.com
npm run tests -- https://example.com
npm run codegen -- https://example.com
```

The first two run the crawler and reusable test library. Codegen opens Playwright's recorder to help generate browser interaction code. For cross-browser checks, install the required engines with `npx playwright install firefox webkit` if they are not already installed. The Docker image installs Chrome for the backend.

## Where output goes

Most output is written under `backend/artifacts/` (relative to the backend process working directory). The exact subfolder depends on the flow: single-page analysis writes page details and screenshots; crawl scans use per-scan directories; reusable test runs save test cases, screenshots, DOM snapshots, and BugOps results in run directories.

## Dependency and configuration

- The npm dependency is declared in `backend/package.json` and locked in `backend/package-lock.json`.
- `backend/Dockerfile` uses a Playwright base image and installs Chrome so the browser engine is available in the container.
- `CRAWL_HEADLESS` controls crawl visibility. Test-runner options can also request headed mode; the CLI exposes it with `--headed`.
- `TESTS_BROWSERS` configures additional engines for cross-browser tests (default: `firefox,webkit`).
