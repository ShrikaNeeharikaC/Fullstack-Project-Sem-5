// Shared behavior across all pages (mobile nav toggle)
document.addEventListener("DOMContentLoaded", () => {
  const toggle = document.querySelector(".nav-toggle");
  const links = document.querySelector(".nav-links");
  if (toggle && links) {
    toggle.addEventListener("click", () => {
      const isOpen = links.style.display === "flex";
      links.style.display = isOpen ? "none" : "flex";
      links.style.flexDirection = "column";
      links.style.position = "absolute";
      links.style.top = "64px";
      links.style.left = "0";
      links.style.right = "0";
      links.style.background = "var(--bg-navbar)";
      links.style.padding = "18px 32px";
      links.style.gap = "16px";
    });
  }
});
