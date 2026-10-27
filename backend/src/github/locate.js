import { serverReachableUrl } from "../browserArgs.js";
import { normalizeSourcePath, originalPosition, parseStack } from "./sourceMap.js";

// Finds the source file/line in the connected repository most likely involved
// in a bug, from the evidence BugOps recorded. Methods, most reliable first:
//   1. stack frame + the site's source map → original file and line   (high)
//   2. stack frame whose URL is itself a repository file (dev servers)  (medium)
//   3. the failing request's route handler in the repository code       (low, suspected)
//   4. the clicked element's text where it is defined in the UI code     (low, suspected)
// Anything else is reported as unidentified. Locations are never invented:
// every file and line comes from the repository at a fixed commit.

const CODE_EXT = /\.(m?[jt]sx?|cjs|vue|svelte|html?|py|rb|php|go|java|cs|kt)$/i;
const UI_EXT = /\.(m?[jt]sx?|vue|svelte|html?)$/i;
const SKIP = /(^|\/)(node_modules|dist|build|out|coverage|vendor|public|\.next|\.nuxt|\.git|__tests__|tests?)\/|\.min\.|\.test\.|\.spec\.|\.d\.ts$/i;
const MAX_FILES = 150;
const MAX_FILE_BYTES = 300_000;
const MAX_SCRIPT_BYTES = 15_000_000;
const FETCH_TIMEOUT_MS = 10_000;

// ---------------------------------------------------------------- repository access

// Repository files at one commit, read lazily and cached (contents at a commit never change).
const indexCache = new Map();
export function repoIndex(client, repo, sha) {
  const key = `${repo}@${sha}`;
  if (indexCache.has(key)) return indexCache.get(key);
  const texts = new Map();
  let listing = null;
  const index = {
    repo,
    sha,
    files: async () => (listing ||= client.listFiles(repo, sha)),
    read(path) {
      if (!texts.has(path)) texts.set(path, client.readFile(repo, path, sha).catch(() => null));
      return texts.get(path);
    },
    // Code files worth searching, smallest set first (ui=true: front-end files only).
    async codeFiles({ ui = false } = {}) {
      const { files } = await index.files();
      return files
        .filter((f) => CODE_EXT.test(f.path) && !SKIP.test(f.path) && f.size <= MAX_FILE_BYTES && (!ui || UI_EXT.test(f.path)))
        .slice(0, MAX_FILES);
    },
    async readAll(files) {
      const out = [];
      for (let i = 0; i < files.length; i += 8) {
        const batch = await Promise.all(files.slice(i, i + 8).map(async (f) => ({ path: f.path, text: await index.read(f.path) })));
        out.push(...batch.filter((f) => typeof f.text === "string"));
      }
      return out;
    },
  };
  indexCache.set(key, index);
  if (indexCache.size > 5) indexCache.delete(indexCache.keys().next().value);
  return index;
}

// The repository file a source path refers to: exact, or the longest unique
// suffix match ("src/pages/Login.jsx" → "client/src/pages/Login.jsx").
export function matchRepoPath(paths, source) {
  const s = normalizeSourcePath(source);
  if (!s || /(^|\/)node_modules\//.test(s)) return null;
  if (paths.includes(s)) return s;
  const hits = paths.filter((p) => p.endsWith(`/${s}`) || s.endsWith(`/${p}`));
  if (!hits.length) return null;
  const longest = Math.max(...hits.map((p) => p.length));
  const best = hits.filter((p) => p.length === longest);
  return best.length === 1 ? best[0] : null;
}

// Does the block opened by the declaration on line `start` still enclose
// line `target` (0-based)? Braces are counted line by line; a function whose
// body closed before `target` (an earlier sibling) does not enclose it.
function encloses(lines, start, target) {
  let depth = 0;
  let opened = false;
  for (let i = start; i < target; i++) {
    for (const ch of lines[i]) {
      if (ch === "{") {
        depth++;
        opened = true;
      } else if (ch === "}") {
        depth--;
      }
    }
    if (opened && depth <= 0) return false;
  }
  return opened || start === target;
}

// Name of the function enclosing a line (searching up to 400 lines above).
export function enclosingFunction(text, line) {
  const lines = text.split("\n");
  for (let i = Math.min(line, lines.length) - 1; i >= Math.max(0, line - 400); i--) {
    const m =
      /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/.exec(lines[i]) ||
      /\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/.exec(lines[i]) ||
      /^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{\s*$/.exec(lines[i]);
    if (!m || ["if", "for", "while", "switch", "catch", "return"].includes(m[1])) continue;
    if (encloses(lines, i, line - 1)) return m[1];
  }
  return null;
}

const lineOf = (text, index) => text.slice(0, index).split("\n").length;
const escapeRegex = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const sameOrigin = (a, b) => {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
};

// ---------------------------------------------------------------- 1 + 2: stack frames

async function fetchText(fetchImpl, url, maxBytes) {
  const res = await fetchImpl(serverReachableUrl(url), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), redirect: "error" });
  if (!res.ok) return null;
  const text = await res.text();
  return text.length <= maxBytes ? text : null;
}

// The source map of a script: inline data URI, the sourceMappingURL comment,
// or <script>.map. Only maps on the scanned site's own origin are fetched.
async function sourceMapFor(fetchImpl, scriptUrl, cache) {
  if (cache.has(scriptUrl)) return cache.get(scriptUrl);
  const promise = (async () => {
    const script = await fetchText(fetchImpl, scriptUrl, MAX_SCRIPT_BYTES).catch(() => null);
    if (!script) return null;
    const ref = /\/\/[#@]\s*sourceMappingURL=(\S+)\s*$/m.exec(script.slice(-2000))?.[1];
    if (ref?.startsWith("data:")) {
      const b64 = /^data:application\/json[^,]*;base64,(.+)$/.exec(ref)?.[1];
      try {
        return b64 ? JSON.parse(Buffer.from(b64, "base64").toString("utf8")) : null;
      } catch {
        return null;
      }
    }
    const mapUrl = new URL(ref || `${scriptUrl.split(/[?#]/)[0]}.map`, scriptUrl).toString();
    if (!sameOrigin(mapUrl, scriptUrl)) return null;
    const text = await fetchText(fetchImpl, mapUrl, MAX_SCRIPT_BYTES).catch(() => null);
    try {
      return text ? JSON.parse(text) : null;
    } catch {
      return null;
    }
  })();
  cache.set(scriptUrl, promise);
  return promise;
}

async function fromStackFrames(evidence, index, link, fetchImpl) {
  const frames = evidence.stacks
    .flatMap((s) => parseStack(s.stack).map((f) => ({ ...f, error: s.message })))
    .filter((f) => sameOrigin(f.url, evidence.pageUrl))
    .slice(0, 12);
  if (!frames.length) return null;
  const paths = (await index.files()).files.map((f) => f.path);
  const maps = new Map();

  for (const frame of frames) {
    const map = await sourceMapFor(fetchImpl, frame.url, maps);
    const pos = map ? originalPosition(map, frame.line, frame.column) : null;
    if (pos) {
      const file = matchRepoPath(paths, pos.source);
      if (!file) continue; // library code (e.g. node_modules): try the next frame
      const text = await index.read(file);
      return link({
        status: "identified",
        sourceFile: file,
        sourceLine: pos.line,
        sourceFunction: pos.name || frame.fn || (text ? enclosingFunction(text, pos.line) : null),
        sourceConfidence: "high",
        sourceReason:
          `The browser reported "${frame.error || "an error"}" with a stack frame at ` +
          `${new URL(frame.url).pathname}:${frame.line}:${frame.column}. The site's source map translates that ` +
          `position to ${normalizeSourcePath(pos.source)} line ${pos.line}, which is ${file} in the repository.`,
      });
    }
    // Unbundled scripts (e.g. a dev server) are served under their own path.
    if (!map) {
      const file = matchRepoPath(paths, new URL(frame.url).pathname);
      if (!file) continue;
      const text = await index.read(file);
      return link({
        status: "identified",
        sourceFile: file,
        sourceLine: frame.line,
        sourceFunction: frame.fn || (text ? enclosingFunction(text, frame.line) : null),
        sourceConfidence: "medium",
        sourceReason:
          `The browser reported "${frame.error}" with a stack frame at ${new URL(frame.url).pathname}:${frame.line}, ` +
          `which is served directly from ${file}. No source map was found, so the line may be shifted if the ` +
          "server transforms the file.",
      });
    }
  }
  return null;
}

// ---------------------------------------------------------------- 3: failing request → route handler

const ROUTE_CALL = /\.(get|post|put|patch|delete|all|route)\(\s*(['"`])([^'"`]*)\2/gi;
// Only server code defines routes; client code calling api.get('/x') must not count.
const SERVER_CODE = /\b(require\(\s*['"]express['"]\)|from\s+['"]express['"]|express\.Router\(|Router\(\)|fastify|from\s+['"]koa|@nestjs|app\.listen\()/;

function routeRegex(pattern) {
  const body = pattern
    .split("/")
    .map((seg) => (seg.startsWith(":") ? "[^/]+" : seg === "*" ? ".*" : escapeRegex(seg)))
    .join("/");
  return new RegExp(`^${body.replace(/\/$/, "")}/?$`);
}

// Resolves "./routes/items" (relative to `from`) to a repository file.
function resolveModule(paths, from, spec) {
  if (!spec.startsWith(".")) return null;
  const parts = from.split("/").slice(0, -1);
  for (const seg of spec.split("/")) {
    if (seg === "..") parts.pop();
    else if (seg !== ".") parts.push(seg);
  }
  const base = parts.join("/");
  return [base, `${base}.js`, `${base}.ts`, `${base}.mjs`, `${base}.cjs`, `${base}/index.js`, `${base}/index.ts`].find((p) => paths.includes(p)) || null;
}

// A handler in `file` for METHOD + `rest` (the path below the mount point).
function findHandler(file, text, method, rest) {
  for (const m of text.matchAll(ROUTE_CALL)) {
    const verb = m[1].toLowerCase();
    if (method && verb !== "all" && verb !== "route" && verb !== method.toLowerCase()) continue;
    if (!routeRegex(m[3] || "/").test(rest || "/")) continue;
    const line = lineOf(text, m.index);
    return { file, line, verb, pattern: m[3] || "/" };
  }
  return null;
}

async function fromFailingRequests(evidence, index, link) {
  const requests = evidence.failedRequests
    .filter((r) => sameOrigin(r.url, evidence.pageUrl) && r.status >= 400 && ![401, 403].includes(r.status))
    .sort((a, b) => b.status - a.status);
  if (!requests.length) return null;
  const files = (await index.readAll((await index.codeFiles()).filter((f) => !/\.(jsx|tsx|vue|svelte|html?)$/i.test(f.path))))
    .filter((f) => SERVER_CODE.test(f.text));
  if (!files.length) return null;
  const paths = (await index.files()).files.map((f) => f.path);

  for (const req of requests.slice(0, 3)) {
    const pathname = new URL(req.url).pathname.replace(/\/$/, "") || "/";
    const segments = pathname.split("/").filter(Boolean);
    const what = `${req.method ? `${req.method} ` : ""}${pathname} returned HTTP ${req.status}`;

    // A route declared with the full path: app.post('/api/items/:id', ...)
    for (const f of files) {
      const hit = findHandler(f.path, f.text, req.method, pathname);
      if (hit && hit.pattern.length > 1) {
        return link({
          status: "suspected",
          sourceFile: hit.file,
          sourceLine: hit.line,
          sourceFunction: `${hit.verb.toUpperCase()} ${hit.pattern} handler`,
          sourceConfidence: "low",
          sourceReason: `The request ${what}. This route definition matches that request, so its handler is the likely place the error happens. This is a correlation, not a stack trace.`,
        });
      }
    }
    // A mount point: app.use('/api/items', require('./routes/items')) + router.post('/', ...)
    for (let n = segments.length; n >= 1; n--) {
      const prefix = `/${segments.slice(0, n).join("/")}`;
      const literal = new RegExp(`(['"\`])${escapeRegex(prefix)}\\1`);
      for (const f of files) {
        const m = literal.exec(f.text);
        if (!m) continue;
        const mountLine = f.text.split("\n")[lineOf(f.text, m.index) - 1];
        const spec =
          /require\(\s*['"]([^'"]+)['"]\s*\)/.exec(mountLine)?.[1] ||
          (() => {
            const id = /,\s*([A-Za-z_$][\w$]*)\s*\)/.exec(mountLine)?.[1];
            return id ? new RegExp(`(?:import\\s+${id}\\s+from|${id}\\s*=\\s*require\\()\\s*['"]([^'"]+)['"]`).exec(f.text)?.[1] : null;
          })();
        const routerFile = spec && resolveModule(paths, f.path, spec);
        const router = routerFile && files.find((x) => x.path === routerFile);
        const rest = pathname.slice(prefix.length) || "/";
        const hit = router && findHandler(router.path, router.text, req.method, rest);
        if (hit) {
          return link({
            status: "suspected",
            sourceFile: hit.file,
            sourceLine: hit.line,
            sourceFunction: `${hit.verb.toUpperCase()} ${prefix}${hit.pattern === "/" ? "" : hit.pattern} handler`,
            sourceConfidence: "low",
            sourceReason:
              `The request ${what}. ${f.path} mounts ${prefix} from ${routerFile}, and this handler there matches ` +
              "the request, so it is the likely place the error happens. This is a correlation, not a stack trace.",
          });
        }
        if (n === segments.length) {
          return link({
            status: "suspected",
            sourceFile: f.path,
            sourceLine: lineOf(f.text, m.index),
            sourceFunction: enclosingFunction(f.text, lineOf(f.text, m.index)),
            sourceConfidence: "low",
            sourceReason: `The request ${what}, and this is where the repository code refers to ${prefix}. This is a correlation, not a stack trace.`,
          });
        }
      }
    }
  }
  return null;
}

// ---------------------------------------------------------------- 4: element text → UI code

async function fromElementText(evidence, index, link) {
  const label = (evidence.elementText || "").trim();
  if (label.length < 3 || label.length > 80) return null;
  const files = await index.readAll(await index.codeFiles({ ui: true }));
  const asText = new RegExp(`>\\s*${escapeRegex(label)}\\s*<|(['"\`])${escapeRegex(label)}\\1`, "g");
  const hits = [];
  for (const f of files) {
    for (const m of f.text.matchAll(asText)) {
      // The line of the label itself (a JSX match starts at the ">" before it).
      const at = m.index + m[0].indexOf(label);
      hits.push({ file: f.path, line: lineOf(f.text, at), text: f.text, jsxText: m[0].startsWith(">") });
    }
  }
  if (!hits.length) return null;
  hits.sort((a, b) => Number(b.jsxText) - Number(a.jsxText));
  const best = hits[0];
  const others = new Set(hits.map((h) => h.file)).size - 1;
  return link({
    status: "suspected",
    sourceFile: best.file,
    sourceLine: best.line,
    sourceFunction: enclosingFunction(best.text, best.line),
    sourceConfidence: "low",
    sourceReason:
      `The bug happened on the element labelled "${label}", and this is where that label is defined in the UI code` +
      `${others ? ` (it also appears in ${others} other file${others === 1 ? "" : "s"})` : ""}. ` +
      "Its event handler is the likely place to look. This is a correlation, not a stack trace.",
  });
}

// ---------------------------------------------------------------- entry point

// evidence: { pageUrl, stacks: [{ message, stack }], failedRequests: [{ method?, url, status }], elementText }
export async function locateSource(evidence, { client, repo, sha, ref, fetchImpl = globalThis.fetch }) {
  const index = repoIndex(client, repo, sha);
  const link = (loc) => ({
    ...loc,
    sourceCodeUrl: `https://github.com/${repo}/blob/${sha}/${loc.sourceFile.split("/").map(encodeURIComponent).join("/")}#L${loc.sourceLine}`,
    commit: sha,
    ref,
  });
  const unidentified = (sourceReason) => ({ status: "unidentified", sourceConfidence: null, sourceReason, commit: sha, ref });

  try {
    await index.files();
  } catch (err) {
    return unidentified(`The repository's code couldn't be read: ${err.message}`);
  }
  const tried = [];
  for (const [method, describe] of [
    [fromStackFrames, "stack traces"],
    [fromFailingRequests, "failing requests"],
    [fromElementText, "the clicked element's text"],
  ]) {
    try {
      const found = await method(evidence, index, link, fetchImpl);
      if (found) return found;
    } catch {}
    tried.push(describe);
  }
  return unidentified(
    `No stack trace, failing request or element text could be matched to a file in ${repo} at ${sha.slice(0, 7)} ` +
      `(tried: ${tried.join(", ")}).`,
  );
}
