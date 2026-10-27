// GitHub Issues: what the dashboard shows for one bug, and the API calls.
// ticketView() is a plain function (no React) so it can be unit tested.

// state: { connected, ticket, pending, error }
//   ticket  { status, issueNumber, issueUrl } from the backend, or null
//   pending true while a create request is running
export function ticketView({ connected, ticket, pending, error }) {
  if (ticket?.status === "created" && ticket.issueUrl) {
    return { kind: "view", label: `View Issue #${ticket.issueNumber}`, href: ticket.issueUrl, disabled: false, message: null };
  }
  if (!connected) {
    return { kind: "connect", label: "Connect GitHub Repository", href: null, disabled: false, message: null };
  }
  if (pending) {
    return { kind: "creating", label: "Creating issue…", href: null, disabled: true, message: null };
  }
  return {
    kind: "create",
    label: error || ticket?.status === "failed" ? "Try again" : "Create GitHub Issue",
    href: null,
    disabled: false,
    message: error || (ticket?.status === "failed" ? "The last attempt failed." : null),
  };
}

// Reads { success, error } JSON; a failed request becomes an Error with the
// server's message (the backend never puts tokens in messages).
async function jsonOrThrow(res) {
  let data = null;
  try {
    data = await res.json();
  } catch {}
  if (!res.ok || !data?.success) throw new Error(data?.error || `Request failed (HTTP ${res.status})`);
  return data;
}

export const getGithubConnection = (apiFetch) => apiFetch("/api/integrations/github").then(jsonOrThrow);

export const connectGithub = (apiFetch, { repo, token, ref, uploadScreenshots }) =>
  apiFetch("/api/integrations/github", {
    method: "PUT",
    body: JSON.stringify({ repo, ref: ref || "", uploadScreenshots: !!uploadScreenshots, ...(token ? { token } : {}) }),
  }).then(jsonOrThrow);

const bugQuery = (url) => (url ? `?url=${encodeURIComponent(url)}` : "");

// { connected, location } — location.status: identified | suspected | unidentified
export const fetchSource = (apiFetch, bug, url) =>
  apiFetch(`/api/bugs/${encodeURIComponent(bug.key)}/source${bugQuery(url)}`).then(jsonOrThrow);

// The screenshot needs the login token, so it's fetched (not an <img src>)
// and shown from an object URL. Resolves to null when there is none.
export async function fetchScreenshotUrl(apiFetch, bug, url) {
  const res = await apiFetch(`/api/bugs/${encodeURIComponent(bug.key)}/screenshot${bugQuery(url)}`);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`Could not load the screenshot (HTTP ${res.status})`);
  return URL.createObjectURL(await res.blob());
}

// Short label for a location's confidence.
export function confidenceLabel(location) {
  if (!location || location.status === "unidentified") return "Not identified";
  return { high: "High confidence", medium: "Medium confidence", low: "Suspected (low confidence)" }[location.sourceConfidence] || "Suspected";
}

export const disconnectGithub = (apiFetch) => apiFetch("/api/integrations/github", { method: "DELETE" }).then(jsonOrThrow);

export const createIssue = (apiFetch, bug, url) =>
  apiFetch(`/api/bugs/${encodeURIComponent(bug.key)}/ticket`, { method: "POST", body: JSON.stringify({ url }) }).then(jsonOrThrow);

export const REPO_FORMAT = /^[A-Za-z0-9][A-Za-z0-9-]{0,38}\/[A-Za-z0-9._-]{1,100}$/;
