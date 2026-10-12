import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { readSession, goToLogin } from "./auth.js";
import "../styles/style.css";

// Renders a page into #root. Pages that need a login send logged-out users
// to login.html (with ?next= back to this page) before anything renders.
export function mount(Page, { requireAuth = false } = {}) {
  if (requireAuth && !readSession()) {
    goToLogin();
    return;
  }
  createRoot(document.getElementById("root")).render(
    <StrictMode>
      <Page />
    </StrictMode>,
  );
}
