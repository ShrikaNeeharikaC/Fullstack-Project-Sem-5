// Login details the user gave for a site during a scan, so the dashboard's
// Re-Scan (the test library) can log in to the same site without asking again.
// Memory only, per BugOps user + site origin: never written to MongoDB, Redis,
// artifacts or logs, and gone when the backend restarts.
const store = new Map();

const keyFor = (userId, url) => {
  try {
    return `${userId}|${new URL(url).origin}`;
  } catch {
    return null;
  }
};

export function rememberCredentials(userId, url, credentials) {
  const key = keyFor(userId, url);
  if (key && credentials) store.set(key, { ...credentials });
}

export function recallCredentials(userId, url) {
  const key = keyFor(userId, url);
  return key ? store.get(key) || null : null;
}
