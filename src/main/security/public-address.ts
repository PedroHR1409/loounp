import { BlockList, isIP } from "node:net";

const blocked = new BlockList();
const globalUnicast = new BlockList();
globalUnicast.addSubnet("2000::", 3, "ipv6");
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const)
  blocked.addSubnet(network, prefix, "ipv4");
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
  ["2001::", 23],
  ["2002::", 16],
  ["3fff::", 20],
  ["100::", 64],
  ["2001::", 32],
  ["::", 96],
] as const)
  blocked.addSubnet(network, prefix, "ipv6");

function embeddedIpv4(address: string): string | null {
  const lower = address.toLowerCase();
  const dotted = lower.match(
    /(?:^::ffff:|^64:ff9b::|^::)(\d+\.\d+\.\d+\.\d+)$/,
  );
  if (dotted) return dotted[1];
  const hex = lower.match(
    /^(?:::ffff:|64:ff9b::)([0-9a-f]{1,4}):([0-9a-f]{1,4})$/,
  );
  if (hex) {
    const high = parseInt(hex[1], 16);
    const low = parseInt(hex[2], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  const sixToFour = lower.match(/^2002:([0-9a-f]{1,4}):([0-9a-f]{1,4}):/);
  if (sixToFour) {
    const high = parseInt(sixToFour[1], 16);
    const low = parseInt(sixToFour[2], 16);
    return `${high >> 8}.${high & 255}.${low >> 8}.${low & 255}`;
  }
  return null;
}

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) return !blocked.check(address, "ipv4");
  if (family !== 6) return false;
  if (blocked.check(address, "ipv6")) return false;
  const inner = embeddedIpv4(address);
  if (inner) return isPublicAddress(inner);
  return globalUnicast.check(address, "ipv6");
}
