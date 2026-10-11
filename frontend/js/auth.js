// Shared by every page: the logged-in session, authenticated API calls, and
// the navbar's Login/SignUp ↔ "Hi, name" + Logout switch.
// Pages that need a login load this as <script src="js/auth.js" data-require-auth>.

const API_BASE = "http://localhost:3000";
const SESSION_KEY = "bugops-session";

// "Remember me" sessions live in localStorage (survive closing the browser);
// others in sessionStorage (gone when the tab closes).
function readSession() {
  for (const store of [localStorage, sessionStorage]) {
    try {
      const raw = store.getItem(SESSION_KEY);
      if (raw) return JSON.parse(raw);
    } catch {}
  }
  return null;
}

function saveSession({ token, user }, remember) {
  clearSession();
  try {
    (remember ? localStorage : sessionStorage).setItem(SESSION_KEY, JSON.stringify({ token, user }));
  } catch {}
}

function clearSession() {
  for (const store of [localStorage, sessionStorage]) {
    try {
      store.removeItem(SESSION_KEY);
    } catch {}
  }
}

// Back to login, remembering where to return afterwards.
function goToLogin() {
  const here = location.pathname.split("/").pop() + location.search;
  location.replace(`login.html?next=${encodeURIComponent(here)}`);
}

// fetch() to the backend with the session token. A 401 means the session
// ended or was never there, so the user is sent to the login page.
async function apiFetch(path, options = {}) {
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

if (document.currentScript?.hasAttribute("data-require-auth") && !readSession()) goToLogin();

function renderNavbar() {
  const box = document.querySelector(".nav-actions");
  const session = readSession();
  if (!box || !session) return;
  box.innerHTML = `<span class="nav-user"></span><button type="button" class="btn btn-dark btn-sm" id="logout-btn">Logout</button>`;
  box.querySelector(".nav-user").textContent = `Hi, ${session.user.name.split(" ")[0]}`;
  box.querySelector("#logout-btn").addEventListener("click", async () => {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch {}
    clearSession();
    location.href = "login.html";
  });
}
document.addEventListener("DOMContentLoaded", renderNavbar);
