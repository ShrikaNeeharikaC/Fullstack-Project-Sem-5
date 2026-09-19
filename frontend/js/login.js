// Login page: client-side validation + simulated login -> redirect to dashboard

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("login-form");
  const emailInput = document.getElementById("login-email");
  const passwordInput = document.getElementById("login-password");
  const emailError = document.getElementById("email-error");
  const passwordError = document.getElementById("password-error");

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    emailError.textContent = "";
    passwordError.textContent = "";

    let hasError = false;
    if (!isValidEmail(emailInput.value)) {
      emailError.textContent = "Enter a valid email address";
      hasError = true;
    }
    if (!passwordInput.value.trim()) {
      passwordError.textContent = "Password is required";
      hasError = true;
    }
    if (hasError) return;

    document.getElementById("login-form-view").style.display = "none";
    document.getElementById("login-success-view").style.display = "block";

    setTimeout(() => {
      window.location.href = "dashboard.html";
    }, 1100);
  });

  document.getElementById("google-login").addEventListener("click", () => {
    document.getElementById("login-form-view").style.display = "none";
    document.getElementById("login-success-view").style.display = "block";
    setTimeout(() => {
      window.location.href = "dashboard.html";
    }, 1100);
  });
});
