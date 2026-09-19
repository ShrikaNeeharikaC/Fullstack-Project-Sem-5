// Signup page: client-side validation + simulated account creation -> redirect to dashboard

function isValidEmail(value) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value.trim());
}

document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("signup-form");
  const nameInput = document.getElementById("signup-name");
  const emailInput = document.getElementById("signup-email");
  const passwordInput = document.getElementById("signup-password");
  const confirmInput = document.getElementById("signup-confirm-password");
  const termsInput = document.getElementById("agree-terms");

  const nameError = document.getElementById("name-error");
  const emailError = document.getElementById("email-error");
  const passwordError = document.getElementById("password-error");
  const confirmError = document.getElementById("confirm-password-error");
  const termsError = document.getElementById("terms-error");

  function finishSignup() {
    document.getElementById("signup-form-view").style.display = "none";
    document.getElementById("signup-success-view").style.display = "block";
    setTimeout(() => {
      window.location.href = "dashboard.html";
    }, 1100);
  }

  form.addEventListener("submit", (e) => {
    e.preventDefault();
    nameError.textContent = "";
    emailError.textContent = "";
    passwordError.textContent = "";
    confirmError.textContent = "";
    termsError.textContent = "";

    let hasError = false;

    if (!nameInput.value.trim()) {
      nameError.textContent = "Name is required";
      hasError = true;
    }
    if (!isValidEmail(emailInput.value)) {
      emailError.textContent = "Enter a valid email address";
      hasError = true;
    }
    if (passwordInput.value.length < 8) {
      passwordError.textContent = "Password must be at least 8 characters";
      hasError = true;
    }
    if (confirmInput.value !== passwordInput.value || !confirmInput.value) {
      confirmError.textContent = "Passwords do not match";
      hasError = true;
    }
    if (!termsInput.checked) {
      termsError.textContent = "You must agree to the terms to continue";
      hasError = true;
    }

    if (hasError) return;
    finishSignup();
  });

  document.getElementById("google-signup").addEventListener("click", finishSignup);
});
