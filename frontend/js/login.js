// Login page: client-side validation, then POST /api/auth/login and keep the session.

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

// Where to go after logging in: ?next= (only pages of this site), else the dashboard.
function nextPage() {
  const next = new URLSearchParams(location.search).get("next");
  return next && /^[\w-]+\.html(\?.*)?$/.test(next) ? next : "dashboard.html";
}

document.addEventListener("DOMContentLoaded", () => {
  if (readSession()) {
    location.replace(nextPage());
    return;
  }

  const form = document.getElementById("login-form");
  const emailInput = document.getElementById("login-email");
  const passwordInput = document.getElementById("login-password");
  const rememberInput = document.getElementById("remember-me");
  const emailError = document.getElementById("email-error");
  const passwordError = document.getElementById("password-error");
  const submitBtn = form.querySelector('button[type="submit"]');

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    emailError.textContent = "";
    passwordError.textContent = "";

    let hasError = false;
    if (!isValidEmail(emailInput.value)) {
      emailError.textContent = "Enter a valid email address";
      hasError = true;
    }
    if (!passwordInput.value) {
      passwordError.textContent = "Password is required";
      hasError = true;
    }
    if (hasError) return;

    submitBtn.disabled = true;
    try {
      const res = await apiFetch("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({
          email: emailInput.value.trim(),
          password: passwordInput.value,
          remember: rememberInput.checked,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        passwordError.textContent = data.error || "Login failed";
        return;
      }
      saveSession(data, rememberInput.checked);
      document.getElementById("login-form-view").style.display = "none";
      document.getElementById("login-success-view").style.display = "block";
      setTimeout(() => location.replace(nextPage()), 800);
    } catch (err) {
      passwordError.textContent = "Can't reach the server. Is the backend running?";
    } finally {
      submitBtn.disabled = false;
    }
  });
});
