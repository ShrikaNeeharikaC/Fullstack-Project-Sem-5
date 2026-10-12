// Signup page: client-side validation, then POST /api/auth/signup and keep the session.
import { useState } from "react";
import Navbar from "../components/Navbar.jsx";
import { apiFetch, isValidEmail, readSession, saveSession } from "../lib/auth.js";
import { mount } from "../lib/mount.jsx";

const NO_ERRORS = { name: "", email: "", password: "", confirm: "", terms: "" };

function Signup() {
  const [form, setForm] = useState({ name: "", email: "", password: "", confirm: "", terms: false });
  const [errors, setErrors] = useState(NO_ERRORS);
  const [submitting, setSubmitting] = useState(false);
  const [success, setSuccess] = useState(false);


  const field = (key) => ({
    value: form[key],
    onChange: (e) => setForm((f) => ({ ...f, [key]: e.target.value })),
  });

  const onSubmit = async (e) => {
    e.preventDefault();
    const next = { ...NO_ERRORS };
    if (!form.name.trim()) next.name = "Name is required";
    if (!isValidEmail(form.email)) next.email = "Enter a valid email address";
    if (form.password.length < 8) next.password = "Password must be at least 8 characters";
    if (form.confirm !== form.password || !form.confirm) next.confirm = "Passwords do not match";
    if (!form.terms) next.terms = "You must agree to the terms to continue";
    setErrors(next);
    if (Object.values(next).some(Boolean)) return;

    setSubmitting(true);
    try {
      const res = await apiFetch("/api/auth/signup", {
        method: "POST",
        body: JSON.stringify({
          name: form.name.trim(),
          email: form.email.trim(),
          password: form.password,
          remember: true,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        // Field errors from the server (e.g. email already registered).
        const server = { ...NO_ERRORS };
        for (const [key, message] of Object.entries(data.errors || {})) {
          if (key in server) server[key] = message;
        }
        if (!data.errors) server.terms = data.error || "Could not create the account";
        setErrors(server);
        return;
      }
      saveSession(data, true);
      setSuccess(true);
      setTimeout(() => location.replace("dashboard.html"), 800);
    } catch (err) {
      setErrors({ ...NO_ERRORS, terms: "Can't reach the server. Is the backend running?" });
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <>
      <Navbar />

      <section className="auth-wrap">
        <div className="auth-card">
          <div id="signup-form-view" style={success ? { display: "none" } : undefined}>
            <a href="index.html" className="logo">
              BugOps
            </a>
            <h1>Create your account</h1>
            <p className="auth-subtext">Start scanning your app for bugs in under a minute.</p>

            <form id="signup-form" className="auth-form" noValidate onSubmit={onSubmit}>
              <div className="form-group">
                <label htmlFor="signup-name">Full name</label>
                <input type="text" id="signup-name" name="name" placeholder="Jane Doe" autoComplete="name" {...field("name")} />
                <span className="field-error" id="name-error">{errors.name}</span>
              </div>
              <div className="form-group">
                <label htmlFor="signup-email">Email</label>
                <input type="email" id="signup-email" name="email" placeholder="you@company.com" autoComplete="email" {...field("email")} />
                <span className="field-error" id="email-error">{errors.email}</span>
              </div>
              <div className="form-group">
                <label htmlFor="signup-password">Password</label>
                <input type="password" id="signup-password" name="password" placeholder="Create a password" autoComplete="new-password" {...field("password")} />
                <span className="field-error" id="password-error">{errors.password}</span>
              </div>
              <div className="form-group">
                <label htmlFor="signup-confirm-password">Confirm password</label>
                <input type="password" id="signup-confirm-password" name="confirmPassword" placeholder="Re-enter your password" autoComplete="new-password" {...field("confirm")} />
                <span className="field-error" id="confirm-password-error">{errors.confirm}</span>
              </div>
              <div className="form-group">
                <label className="checkbox-row">
                  <input type="checkbox" id="agree-terms" checked={form.terms}
                    onChange={(e) => setForm((f) => ({ ...f, terms: e.target.checked }))} />
                  I agree to the <a href="#terms" className="forgot-link">Terms of Service</a> and <a href="#privacy" className="forgot-link">Privacy Policy</a>
                </label>
                <span className="field-error" id="terms-error">{errors.terms}</span>
              </div>
              <button type="submit" className="btn btn-dark btn-block" disabled={submitting}>Create Account</button>
            </form>

            <p className="auth-switch">Already have an account? <a href="login.html">Log in</a></p>
          </div>

          <div id="signup-success-view" className="auth-success" style={success ? { display: "block" } : undefined}>
            <svg className="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><circle cx="12" cy="12" r="10" /><polyline points="8 12 11 15 16 9" /></svg>
            <h2>Account created</h2>
            <p>Taking you to your dashboard&hellip;</p>
          </div>
        </div>
      </section>
    </>
  );
}

// Already logged in: skip the form.
if (readSession()) location.replace("dashboard.html");
else mount(Signup);
