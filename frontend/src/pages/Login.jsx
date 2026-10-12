// Login page: client-side validation, then POST /api/auth/login and keep the session.
import { useState } from "react";
import Navbar from "../components/Navbar.jsx";
import { apiFetch, isValidEmail, readSession, saveSession } from "../lib/auth.js";
import { mount } from "../lib/mount.jsx";

// Where to go after logging in: ?next= (only pages of this site), else the dashboard.
function nextPage() {
  const next = new URLSearchParams(location.search).get("next");
  return next && /^[\w-]+\.html(\?.*)?$/.test(next) ? next : "dashboard.html";
}

function Login() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [remember, setRemember] = useState(false);
  const [errors, setErrors] = useState({ email: "", password: "" });
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);


  const onSubmit = async (e) => {
    e.preventDefault();
    const next = { email: "", password: "" };
    if (!isValidEmail(email)) next.email = "Enter a valid email address";
    if (!password) next.password = "Password is required";
    setErrors(next);
    if (next.email || next.password) return;

    setSubmitting(true);
    try {
      const res = await apiFetch("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email: email.trim(), password, remember }),
      });
      const data = await res.json();
      if (!data.success) {
        setErrors({ email: "", password: data.error || "Login failed" });
        return;
      }
      saveSession(data, remember);
      setSuccess(true);
      setTimeout(() => location.replace(nextPage()), 800);
    } catch (err) {
      setErrors({ email: "", password: "Can't reach the server. Is the backend running?" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Navbar />

      <section className="auth-wrap">
        <div className="auth-card">
          <div id="login-form-view" style={success ? { display: "none" } : undefined}>
            <a href="index.html" className="logo">
              BugOps
            </a>
            <h1>Welcome back</h1>
            <p className="auth-subtext">Log in to see your scans and bug reports.</p>

            <form id="login-form" className="auth-form" noValidate onSubmit={onSubmit}>
              <div className="form-group">
                <label htmlFor="login-email">Email</label>
                <input type="email" id="login-email" name="email" placeholder="you@company.com" autoComplete="email"
                  value={email} onChange={(e) => setEmail(e.target.value)} />
                <span className="field-error" id="email-error">{errors.email}</span>
              </div>
              <div className="form-group">
                <label htmlFor="login-password">Password</label>
                <input type="password" id="login-password" name="password" placeholder="Enter your password" autoComplete="current-password"
                  value={password} onChange={(e) => setPassword(e.target.value)} />
                <span className="field-error" id="password-error">{errors.password}</span>
              </div>
              <div className="form-row-between">
                <label className="checkbox-row">
                  <input type="checkbox" id="remember-me" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                  Remember me
                </label>
                <a href="#forgot-password" className="forgot-link">Forgot password?</a>
              </div>
              <button type="submit" className="btn btn-dark btn-block" disabled={submitting}>Log In</button>
            </form>

            <p className="auth-switch">Don't have an account? <a href="signup.html">Sign up</a></p>
          </div>

          <div id="login-success-view" className="auth-success" style={success ? { display: "block" } : undefined}>
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="10" /><polyline points="8 12 11 15 16 9" /></svg>
            <h2>Logged in</h2>
            <p>Taking you to your dashboard&hellip;</p>
          </div>
        </div>
      </section>
    </>
  );
}

// Already logged in: skip the form.
if (readSession()) location.replace(nextPage());
else mount(Login);
