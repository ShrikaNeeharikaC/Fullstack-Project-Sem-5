import { useState } from "react";
import { apiFetch, clearSession, readSession } from "../lib/auth.js";

// Mobile menu styles (applied once the hamburger has been used).
const MOBILE_MENU = {
  flexDirection: "column",
  position: "absolute",
  top: "64px",
  left: "0",
  right: "0",
  background: "var(--bg-navbar)",
  padding: "18px 32px",
  gap: "16px",
};

// Top navbar shared by every page. `active` is "home" or "dashboard".
// Logged in: "Hi, name" + Logout; otherwise Login / SignUp.
export default function Navbar({ active }) {
  const [menuOpen, setMenuOpen] = useState(null); // null = never toggled
  const session = readSession();

  const logout = async () => {
    try {
      await apiFetch("/api/auth/logout", { method: "POST" });
    } catch {}
    clearSession();
    location.href = "login.html";
  };

  return (
    <header className="navbar">
      <div className="navbar-inner">
        <a href="index.html" className="logo">
          BugOps
        </a>
        <nav
          className="nav-links"
          style={menuOpen === null ? undefined : { ...MOBILE_MENU, display: menuOpen ? "flex" : "none" }}
        >
          <a href="index.html" className={active === "home" ? "active" : undefined}>Home</a>
          <a href="dashboard.html" className={active === "dashboard" ? "active" : undefined}>Dashboard</a>
        </nav>
        <div className="nav-actions">
          {session ? (
            <>
              <span className="nav-user">Hi, {session.user.name.split(" ")[0]}</span>
              <button type="button" className="btn btn-dark btn-sm" id="logout-btn" onClick={logout}>
                Logout
              </button>
            </>
          ) : (
            <>
              <a href="login.html" className="btn btn-dark btn-sm">Login</a>
              <a href="signup.html" className="btn btn-dark btn-sm">SignUp</a>
            </>
          )}
        </div>
        <button className="nav-toggle" aria-label="Toggle navigation" onClick={() => setMenuOpen((open) => !open)}>
          <span></span><span></span><span></span>
        </button>
      </div>
    </header>
  );
}
