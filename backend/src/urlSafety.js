import { lookup } from "node:dns/promises";
import { isIP } from "node:net";

const dnsCache = new Map();
const DNS_CACHE_MS = 5_000;

function isPublicIpv4(address) {
  const octets = address.split(".").map(Number);
  if (octets.length !== 4 || octets.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = octets;
  return !(
    a === 0 || a === 10 || a === 127 || a >= 224 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0) ||
    (a === 192 && b === 168) ||
    (a === 192 && b === 88 && c === 99) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113)
  );
}

function ipv6Groups(address) {
  let value = address.toLowerCase().split("%")[0];
  if (value.includes(".")) {
    const lastColon = value.lastIndexOf(":");
    const tail = value.slice(lastColon + 1);
    if (!isPublicIpv4(tail)) return null;
    const [a, b, c, d] = tail.split(".").map(Number);
    value = `${value.slice(0, lastColon)}:${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const halves = value.split("::");
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const missing = 8 - left.length - right.length;
  if ((halves.length === 1 && missing !== 0) || (halves.length === 2 && missing < 1)) return null;
  const groups = [...left, ...Array(missing).fill("0"), ...right].map((part) => Number.parseInt(part || "0", 16));
  return groups.length === 8 && groups.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? groups : null;
}

function isPublicIp(address) {
  const version = isIP(address);
  if (version === 4) return isPublicIpv4(address);
  if (version !== 6) return false;
  const groups = ipv6Groups(address);
  if (!groups) return false;
  // IPv4-mapped IPv6 address: apply the IPv4 rules to the embedded address.
  if (groups.slice(0, 5).every((n) => n === 0) && groups[5] === 0xffff) {
    return isPublicIpv4(`${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`);
  }
  // Public global-unicast IPv6 is in 2000::/3. Exclude documentation and
  // benchmarking blocks, which are not valid public scan targets.
  return groups[0] >= 0x2000 && groups[0] <= 0x3fff &&
    !(groups[0] === 0x2001 && (groups[1] <= 0x0001 || groups[1] === 0x0db8 || (groups[1] === 0x0002 && groups[2] === 0))) &&
    groups[0] !== 0x2002;
}

async function resolvedAddresses(hostname) {
  const cached = dnsCache.get(hostname);
  if (cached && cached.expiresAt > Date.now()) return cached.addresses;
  const records = await lookup(hostname, { all: true, verbatim: true });
  const addresses = records.map((record) => record.address);
  dnsCache.set(hostname, { addresses, expiresAt: Date.now() + DNS_CACHE_MS });
  return addresses;
}

export async function publicHttpUrlError(input) {
  let parsed;
  try {
    parsed = input instanceof URL ? input : new URL(String(input));
  } catch {
    return "Enter a valid URL";
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return "Only http and https URLs are allowed";
  if (parsed.username || parsed.password) return "URLs containing credentials are not allowed";

  const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!hostname || hostname === "localhost" || (isIP(hostname) === 0 && !hostname.includes(".")) ||
      /\.(localhost|local|internal|lan|home|home\.arpa)$/.test(hostname)) {
    return "Local and private network addresses cannot be scanned";
  }

  try {
    const addresses = isIP(hostname) ? [hostname] : await resolvedAddresses(hostname);
    if (!addresses.length || addresses.some((address) => !isPublicIp(address))) {
      return "The URL resolves to a private or reserved network address and cannot be scanned";
    }
  } catch {
    return "The URL hostname could not be resolved";
  }
  return null;
}

export async function installPublicNetworkGuard(context) {
  await context.route("**/*", async (route) => {
    const requestUrl = route.request().url();
    if (!requestUrl.startsWith("http://") && !requestUrl.startsWith("https://")) {
      await route.continue();
      return;
    }
    if (await publicHttpUrlError(requestUrl)) {
      await route.abort("blockedbyclient");
      return;
    }
    await route.continue();
  });
}
