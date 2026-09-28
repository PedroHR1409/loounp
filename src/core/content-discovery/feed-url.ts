const PRIVATE_HOSTNAMES = new Set(["localhost", "0.0.0.0"]);

function isPrivateIpv4(address: string): boolean {
  const ipv4 = address.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!ipv4) return false;
  const [a, b] = ipv4.slice(1).map(Number);
  return (
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && (b === 0 || b === 168)) ||
    (a === 198 && (b === 18 || b === 19)) ||
    a >= 224
  );
}

function ipv6Groups(address: string): number[] | null {
  let normalized = address;
  if (normalized.includes(".")) {
    const separator = normalized.lastIndexOf(":");
    if (separator < 0) return null;
    const ipv4 = normalized
      .slice(separator + 1)
      .split(".")
      .map(Number);
    if (ipv4.length !== 4 || ipv4.some((part) => part < 0 || part > 255))
      return null;
    normalized = `${normalized.slice(0, separator)}:${((ipv4[0] << 8) | ipv4[1]).toString(16)}:${((ipv4[2] << 8) | ipv4[3]).toString(16)}`;
  }

  const halves = normalized.split("::");
  if (halves.length > 2) return null;
  const left = halves[0]
    ? halves[0].split(":").map((word) => parseInt(word, 16))
    : [];
  const right =
    halves.length === 2 && halves[1]
      ? halves[1].split(":").map((word) => parseInt(word, 16))
      : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0 || (halves.length === 1 && missing !== 0)) return null;
  const groups = [...left, ...Array(missing).fill(0), ...right];
  return groups.length === 8 &&
    groups.every(
      (word) => Number.isInteger(word) && word >= 0 && word <= 0xffff,
    )
    ? groups
    : null;
}

function embeddedIpv4(groups: number[], offset: number): string {
  const high = groups[offset];
  const low = groups[offset + 1];
  return `${high >>> 8}.${high & 0xff}.${low >>> 8}.${low & 0xff}`;
}

function isPrivateIpv6(address: string): boolean {
  const groups = ipv6Groups(address);
  if (!groups) return false;

  const allZeroPrefix = groups.slice(0, 6).every((word) => word === 0);
  if (allZeroPrefix) return isPrivateIpv4(embeddedIpv4(groups, 6));
  if (groups.slice(0, 5).every((word) => word === 0) && groups[5] === 0xffff)
    return isPrivateIpv4(embeddedIpv4(groups, 6));

  const first = groups[0];
  if (
    (first & 0xfe00) === 0xfc00 || // unique local
    (first & 0xffc0) === 0xfe80 || // link local
    (first & 0xffc0) === 0xfec0 || // deprecated site local
    (first & 0xff00) === 0xff00 // multicast
  )
    return true;

  // NAT64 and 6to4 can carry an IPv4 destination inside an IPv6 address.
  if (groups[0] === 0x0064 && groups[1] === 0xff9b && groups[2] === 0)
    return isPrivateIpv4(embeddedIpv4(groups, 6));
  if (groups[0] === 0x2002) return isPrivateIpv4(embeddedIpv4(groups, 1));
  return false;
}

function isPrivateOrLoopbackHost(hostname: string): boolean {
  const host = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (
    PRIVATE_HOSTNAMES.has(host) ||
    host.endsWith(".localhost") ||
    host.endsWith(".local") ||
    host.endsWith(".internal")
  )
    return true;
  if (host.includes(":")) return isPrivateIpv6(host);
  if (/^\d+(?:\.\d+){3}$/.test(host)) return isPrivateIpv4(host);
  return false;
}

/** Validates the scheme and common private hosts; DNS is checked and pinned at fetch time. */
export function validateFeedUrl(value: unknown): string {
  if (typeof value !== "string")
    throw new TypeError("URL do feed deve ser texto.");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new TypeError("URL do feed inválida.");
  }
  if (url.protocol !== "https:")
    throw new TypeError("Feeds RSS devem usar HTTPS.");
  if (url.username || url.password)
    throw new TypeError("Feed URLs must not contain credentials.");
  if (isPrivateOrLoopbackHost(url.hostname))
    throw new TypeError("Host de rede privada/local não é permitido.");
  url.hash = "";
  return url.toString();
}
