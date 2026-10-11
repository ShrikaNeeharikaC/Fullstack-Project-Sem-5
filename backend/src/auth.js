import crypto from "crypto";
import { promisify } from "util";
import express from "express";
import { sessions, users } from "./db.js";

// Email + password accounts. Passwords are hashed with scrypt (built into
// Node). A login returns a random session token; the browser sends it back as
// "Authorization: Bearer <token>". Only a hash of the token is stored, so a
// leaked database can't be used to log in.

const scrypt = promisify(crypto.scrypt);
const DAY_MS = 24 * 60 * 60 * 1000;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${key.toString("hex")}`;
}

async function verifyPassword(password, stored) {
  const [scheme, saltHex, keyHex] = String(stored || "").split("$");
  if (scheme !== "scrypt" || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, "hex");
  const key = await scrypt(password, Buffer.from(saltHex, "hex"), expected.length);
  return crypto.timingSafeEqual(key, expected);
}

const tokenHash = (token) => crypto.createHash("sha256").update(token).digest("hex");

// "Remember me" keeps the session for 30 days; otherwise 1 day.
async function createSession(userId, remember) {
  const token = crypto.randomBytes(32).toString("base64url");
  await sessions().insertOne({
    _id: tokenHash(token),
    userId,
    createdAt: new Date(),
    expiresAt: new Date(Date.now() + (remember ? 30 : 1) * DAY_MS),
  });
  return token;
}

const publicUser = (u) => ({ id: String(u._id), name: u.name, email: u.email });

// Rejects requests without a valid session; otherwise sets req.user.
export async function requireAuth(req, res, next) {
  const match = (req.headers.authorization || "").match(/^Bearer (\S+)$/);
  if (!match) return res.status(401).json({ success: false, error: "Please log in" });
  const session = await sessions().findOne({ _id: tokenHash(match[1]), expiresAt: { $gt: new Date() } });
  const user = session && (await users().findOne({ _id: session.userId }));
  if (!user) return res.status(401).json({ success: false, error: "Your session has expired. Please log in again." });
  req.user = user;
  req.sessionId = session._id;
  next();
}

// Slows down password guessing: 5 failed logins per email+IP per 15 minutes.
const failures = new Map();
const WINDOW_MS = 15 * 60 * 1000;
function tooManyFailures(key) {
  const entry = failures.get(key);
  return !!entry && entry.count >= 5 && Date.now() - entry.first < WINDOW_MS;
}
function noteFailure(key) {
  const entry = failures.get(key);
  if (!entry || Date.now() - entry.first >= WINDOW_MS) failures.set(key, { count: 1, first: Date.now() });
  else entry.count++;
}

export const authRouter = express.Router();

authRouter.post("/signup", async (req, res) => {
  const name = String(req.body?.name || "").trim();
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");

  const errors = {};
  if (!name || name.length > 100) errors.name = "Name is required";
  if (!EMAIL.test(email) || email.length > 254) errors.email = "Enter a valid email address";
  if (password.length < 8) errors.password = "Password must be at least 8 characters";
  if (password.length > 200) errors.password = "Password is too long";
  if (Object.keys(errors).length) return res.status(400).json({ success: false, errors });

  let userId;
  try {
    const result = await users().insertOne({ name, email, passwordHash: await hashPassword(password), createdAt: new Date() });
    userId = result.insertedId;
  } catch (err) {
    if (err.code === 11000) {
      return res.status(409).json({ success: false, errors: { email: "An account with this email already exists" } });
    }
    throw err;
  }
  const token = await createSession(userId, !!req.body?.remember);
  res.status(201).json({ success: true, token, user: { id: String(userId), name, email } });
});

authRouter.post("/login", async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const key = `${email}|${req.ip}`;
  if (tooManyFailures(key)) {
    return res.status(429).json({ success: false, error: "Too many failed attempts. Try again in 15 minutes." });
  }
  const user = await users().findOne({ email });
  // Same message whether the email or the password is wrong.
  if (!user || !(await verifyPassword(password, user.passwordHash))) {
    noteFailure(key);
    return res.status(401).json({ success: false, error: "Invalid email or password" });
  }
  failures.delete(key);
  const token = await createSession(user._id, !!req.body?.remember);
  res.json({ success: true, token, user: publicUser(user) });
});

authRouter.post("/logout", requireAuth, async (req, res) => {
  await sessions().deleteOne({ _id: req.sessionId });
  res.json({ success: true });
});

authRouter.get("/me", requireAuth, (req, res) => {
  res.json({ success: true, user: publicUser(req.user) });
});
