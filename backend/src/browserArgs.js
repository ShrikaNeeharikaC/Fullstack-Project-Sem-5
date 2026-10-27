// Inside Docker, "localhost" in the scanned URL means the container itself, not
// the machine running the app under test. With HOST_LOOPBACK_TO_HOST=true,
// Chrome resolves localhost/127.0.0.1 to host.docker.internal instead. The URL
// (and its Host header) stay as typed, so dev servers that check the host still accept it.
// The same mapping for requests the backend makes itself (fetching the scanned
// site's scripts and source maps).
export function serverReachableUrl(url) {
  if (process.env.HOST_LOOPBACK_TO_HOST !== "true") return url;
  const u = new URL(url);
  if (u.hostname === "localhost" || u.hostname === "127.0.0.1") u.hostname = "host.docker.internal";
  return u.toString();
}

export function chromeArgs() {
  if (process.env.HOST_LOOPBACK_TO_HOST !== "true") return [];
  return ["--host-resolver-rules=MAP localhost host.docker.internal, MAP 127.0.0.1 host.docker.internal"];
}
