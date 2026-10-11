// Signup page: client-side validation, then POST /api/auth/signup and keep the session.

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

document.addEventListener("DOMContentLoaded", () => {
  if (readSession()) {
    location.replace("dashboard.html");
    return;
  }

  const form = document.getElementById("signup-form");
  const nameInput = document.getElementById("signup-name");
  const emailInput = document.getElementById("signup-email");
  const passwordInput = document.getElementById("signup-password");
  const confirmInput = document.getElementById("signup-confirm-password");
  const termsInput = document.getElementById("agree-terms");
  const submitBtn = form.querySelector('button[type="submit"]');

  const errors = {
    name: document.getElementById("name-error"),
    email: document.getElementById("email-error"),
    password: document.getElementById("password-error"),
    confirm: document.getElementById("confirm-password-error"),
    terms: document.getElementById("terms-error"),
  };

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    Object.values(errors).forEach((el) => (el.textContent = ""));

    let hasError = false;
    if (!nameInput.value.trim()) {
      errors.name.textContent = "Name is required";
      hasError = true;
    }
    if (!isValidEmail(emailInput.value)) {
      errors.email.textContent = "Enter a valid email address";
      hasError = true;
    }
    if (passwordInput.value.length < 8) {
      errors.password.textContent = "Password must be at least 8 characters";
      hasError = true;
    }
    if (confirmInput.value !== passwordInput.value || !confirmInput.value) {
      errors.confirm.textContent = "Passwords do not match";
      hasError = true;
    }
    if (!termsInput.checked) {
      errors.terms.textContent = "You must agree to the terms to continue";
      hasError = true;
    }
    if (hasError) return;

    submitBtn.disabled = true;
    try {
      const res = await apiFetch("/api/auth/signup", {
        method: "POST",
        body: JSON.stringify({
          name: nameInput.value.trim(),
          email: emailInput.value.trim(),
          password: passwordInput.value,
          remember: true,
        }),
      });
      const data = await res.json();
      if (!data.success) {
        // Field errors from the server (e.g. email already registered).
        for (const [field, message] of Object.entries(data.errors || {})) {
          if (errors[field]) errors[field].textContent = message;
        }
        if (!data.errors) errors.terms.textContent = data.error || "Could not create the account";
        return;
      }
      saveSession(data, true);
      document.getElementById("signup-form-view").style.display = "none";
      document.getElementById("signup-success-view").style.display = "block";
      setTimeout(() => location.replace("dashboard.html"), 800);
    } catch (err) {
      errors.terms.textContent = "Can't reach the server. Is the backend running?";
    } finally {
      submitBtn.disabled = false;
    }
  });
});
