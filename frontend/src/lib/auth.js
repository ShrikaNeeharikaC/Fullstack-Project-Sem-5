// Shared by every page: the logged-in session and authenticated API calls.

// Set VITE_API_BASE at build time (Vercel env var) to the deployed backend URL.
export const API_BASE = (import.meta.env.VITE_API_BASE || "http://localhost:3000").replace(/\/+$/, "");
const SESSION_KEY = "bugops-session";

// "Remember me" sessions live in localStorage (survive closing the browser);
// others in sessionStorage (gone when the tab closes).
export function readSession() {
  for (const store of [localStorage, sessionStorage]) {
    try {
      const raw = store.getItem(SESSION_KEY);
      if (raw) return JSON.parse(raw);
    } catch {}
  }
  return null;
}

export function saveSession({ token, user }, remember) {
  clearSession();
  try {
    (remember ? localStorage : sessionStorage).setItem(SESSION_KEY, JSON.stringify({ token, user }));
  } catch {}
}

export function clearSession() {
  for (const store of [localStorage, sessionStorage]) {
    try {
      store.removeItem(SESSION_KEY);
    } catch {}
  }
}

// Back to login, remembering where to return afterwards.
export function goToLogin() {
  const here = location.pathname.split("/").pop() + location.search;
  location.replace(`login.html?next=${encodeURIComponent(here)}`);
}

// fetch() to the backend with the session token. A 401 means the session
// ended or was never there, so the user is sent to the login page.
export async function apiFetch(path, options = {}) {
  const session = readSession();
  const headers = { ...(options.headers || {}) };
  if (session) headers.Authorization = `Bearer ${session.token}`;
  if (options.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
  const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
  if (res.status === 401 && !path.startsWith("/api/auth/")) {
    clearSession();
    goToLogin();
    throw new Error("Not logged in");
  }
  return res;
}

export function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}
