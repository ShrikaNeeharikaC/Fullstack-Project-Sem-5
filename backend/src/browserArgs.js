// Inside Docker, "localhost" in the scanned URL means the container itself, not
// the machine running the app under test. With HOST_LOOPBACK_TO_HOST=true,
// Chrome resolves localhost/127.0.0.1 to host.docker.internal instead. The URL
// (and its Host header) stay as typed, so dev servers that check the host still accept it.
export function chromeArgs() {
  if (process.env.HOST_LOOPBACK_TO_HOST !== "true") return [];
  return ["--host-resolver-rules=MAP localhost host.docker.internal, MAP 127.0.0.1 host.docker.internal"];
}
