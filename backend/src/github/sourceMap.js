// Stack-trace parsing and source-map lookup (Source Map v3), no dependencies.

// "    at onClick (http://host/assets/index-abc.js:40:1234)" or
// "    at http://host/assets/index-abc.js:40:1234"
const FRAME = /^\s*at (?:(.+?) \()?((?:https?|file):\/\/[^\s()]+?):(\d+):(\d+)\)?\s*$/;

export function parseStack(stack) {
  return String(stack || "")
    .split("\n")
    .map((line) => FRAME.exec(line))
    .filter(Boolean)
    .map(([, fn, url, line, column]) => ({ fn: fn && !/^(async|new)$/.test(fn) ? fn.replace(/^async /, "") : null, url, line: Number(line), column: Number(column) }));
}

const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
const B64_VALUE = Object.fromEntries([...B64].map((c, i) => [c, i]));

function decodeVlq(segment) {
  const out = [];
  let value = 0;
  let shift = 0;
  for (const ch of segment) {
    const digit = B64_VALUE[ch];
    if (digit === undefined) throw new Error("Invalid source map mapping");
    value += (digit & 31) << shift;
    if (digit & 32) {
      shift += 5;
    } else {
      out.push(value & 1 ? -(value >>> 1) : value >>> 1);
      value = 0;
      shift = 0;
    }
  }
  return out;
}

// Original position of a generated (1-based line, 1-based column) position:
// the mapping segment on that line with the greatest column not after it.
export function originalPosition(map, line, column) {
  if (!map || map.version !== 3 || typeof map.mappings !== "string" || map.sections) return null;
  const lines = map.mappings.split(";");
  if (line < 1 || line > lines.length) return null;
  // Source/line/column/name fields are relative across the whole file, so
  // every earlier line must be decoded to know their running values.
  let src = 0;
  let srcLine = 0;
  let srcCol = 0;
  let name = 0;
  let best = null;
  for (let i = 0; i < line; i++) {
    let genCol = 0;
    for (const segment of lines[i].split(",")) {
      if (!segment) continue;
      const f = decodeVlq(segment);
      genCol += f[0];
      if (f.length >= 4) {
        src += f[1];
        srcLine += f[2];
        srcCol += f[3];
        if (f.length >= 5) name += f[4];
      }
      if (i === line - 1 && f.length >= 4 && genCol <= column - 1) {
        best = { source: src, line: srcLine + 1, column: srcCol + 1, name: f.length >= 5 ? name : null };
      }
    }
  }
  if (!best || !map.sources?.[best.source]) return null;
  const root = map.sourceRoot ? map.sourceRoot.replace(/\/?$/, "/") : "";
  return {
    source: root + map.sources[best.source],
    line: best.line,
    column: best.column,
    name: best.name !== null ? map.names?.[best.name] || null : null,
  };
}

// "webpack://app/./src/x.js", "/@fs/home/me/app/src/x.js", "../../src/x.js?v=1"
// → "src/x.js"-style path, for matching against repository files.
export function normalizeSourcePath(source) {
  return String(source || "")
    .replace(/^[a-z]+:\/\/\//i, "")
    .replace(/^[a-z]+:\/\/[^/]*\//i, "")
    .replace(/[?#].*$/, "")
    .replace(/^\/@fs\//, "/")
    .replace(/^(\.\.?\/)+/, "")
    .replace(/^\/+/, "");
}
