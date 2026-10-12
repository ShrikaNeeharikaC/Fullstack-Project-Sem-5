// "Just now", "5 min ago", "2 hours ago", "Yesterday", "3 days ago", or a date.
// The scan page shows the lowercase variants ("just now", "yesterday").
export function relativeTime(iso, { lowercase = false } = {}) {
  if (!iso) return "never";
  const then = new Date(iso);
  const mins = Math.round((Date.now() - then) / 60000);
  if (mins < 1) return lowercase ? "just now" : "Just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? "" : "s"} ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return lowercase ? "yesterday" : "Yesterday";
  if (days < 7) return `${days} days ago`;
  return then.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

export function displayUrl(url) {
  return String(url || "").replace(/^https?:\/\//i, "").replace(/#\/?$/, "").replace(/\/$/, "");
}

export const dashboardLink = (url) => `dashboard.html?url=${encodeURIComponent(url)}`;
