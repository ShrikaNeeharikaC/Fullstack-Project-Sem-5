import { MongoClient } from "mongodb";

// MongoDB holds accounts, login sessions, and which user ran which scan.
// Scan results themselves (reports, screenshots) stay in artifacts/ on disk.
//   users     { name, email (unique, lowercase), passwordHash, createdAt }
//   sessions  { _id: sha256(token), userId, createdAt, expiresAt }   expired ones are deleted by Mongo (TTL)
//   scans     { userId, kind: "crawl" | "tests", runId, url, targetKey, status, startedAt, finishedAt, error }
//   integrations { userId, provider: "github", repo, token: <AES-256-GCM box>, connectedAt, updatedAt }
//   tickets   { userId, bugKey, repo, status: "creating" | "created" | "failed", issueNumber, issueUrl, ... }
//             one per user + bug + repo (unique), so the same bug never gets two issues
//   bugSources { userId, bugKey, repo, commit, location, computedAt }   cached likely source location

let client = null;
let db = null;

export async function connectDb() {
  const uri = process.env.MONGODB_URI;
  if (!uri) throw new Error("MONGODB_URI is not set. Add it to backend/.env (see .env.example).");
  client = new MongoClient(uri, { serverSelectionTimeoutMS: 5000 });
  await client.connect();
  db = client.db(process.env.MONGODB_DB || "bugops");
  await Promise.all([
    db.collection("users").createIndex({ email: 1 }, { unique: true }),
    db.collection("sessions").createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    db.collection("sessions").createIndex({ userId: 1 }),
    db.collection("scans").createIndex({ runId: 1 }, { unique: true }),
    db.collection("scans").createIndex({ userId: 1, targetKey: 1, finishedAt: -1 }),
    db.collection("integrations").createIndex({ userId: 1, provider: 1 }, { unique: true }),
    db.collection("tickets").createIndex({ userId: 1, bugKey: 1, repo: 1 }, { unique: true }),
    db.collection("bugSources").createIndex({ userId: 1, bugKey: 1, repo: 1, commit: 1 }, { unique: true }),
  ]);
  return db;
}

export async function closeDb() {
  await client?.close();
}

function collection(name) {
  if (!db) throw new Error("Database not connected");
  return db.collection(name);
}

export const users = () => collection("users");
export const sessions = () => collection("sessions");
export const scans = () => collection("scans");
export const integrations = () => collection("integrations");
export const tickets = () => collection("tickets");
export const bugSources = () => collection("bugSources");
