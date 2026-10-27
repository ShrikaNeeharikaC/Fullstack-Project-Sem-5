import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";

test("shared navigation contains working Home and Dashboard links and no About Us link", () => {
  const navbar = fs.readFileSync(new URL("./Navbar.jsx", import.meta.url), "utf8");
  assert.match(navbar, /href="index\.html"[^>]*>Home<\/a>/);
  assert.match(navbar, /href="dashboard\.html"[^>]*>Dashboard<\/a>/);
  assert.doesNotMatch(navbar, /About\s*Us|#about/i);
});

test("authentication navigation remains available", () => {
  const navbar = fs.readFileSync(new URL("./Navbar.jsx", import.meta.url), "utf8");
  assert.match(navbar, /href="login\.html"/);
  assert.match(navbar, /href="signup\.html"/);
  assert.match(navbar, /onClick=\{logout\}/);
});
