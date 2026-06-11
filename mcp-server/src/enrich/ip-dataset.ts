// Offline IPv4 enrichment dataset (issue #415 Gap B).
//
// Air-gapped by construction: enrichment comes from a LOCAL dataset the
// operator supplies (OMCP_IP_ENRICH_FILE), never a per-line phone-home to an
// external geo/ASN API. The format is a dependency-free CSV so no parser
// library (and no npm install on the host) is needed:
//
//   network,country,city,asn,org,hosting
//   1.2.3.0/24,US,Ashburn,AS14618,Example Cloud,true
//   203.0.113.5,DE,Berlin,AS3320,Example ISP,false
//
// - `network` is an IPv4 or IPv6 CIDR (or a bare address, treated as /32 or
//   /128). Both families are supported; IPv4 uses fast 32-bit integer ranges,
//   IPv6 uses 128-bit BigInt ranges. IPv4-mapped IPv6 (`::ffff:1.2.3.4`) parses.
// - Remaining columns are optional; an empty cell is omitted from the result.
// - `hosting` is the "is this a datacenter / hosting / proxy range" flag — the
//   signal that separates real humans from bots/scanners/VPN-exit-nodes. Parsed
//   truthily from true/1/yes (case-insensitive); anything else is false.
// - Lines that are blank or start with `#` are ignored. A header row whose
//   first cell is literally `network` is skipped.

export interface IpEnrichment {
  country?: string;
  city?: string;
  asn?: string;
  org?: string;
  hosting?: boolean;
}

interface Range {
  start: number; // inclusive, unsigned 32-bit
  end: number; // inclusive
  prefix: number; // CIDR prefix length — larger = more specific
  data: IpEnrichment;
}

interface Range6 {
  start: bigint; // inclusive, 128-bit
  end: bigint; // inclusive
  prefix: number; // CIDR prefix length (0–128) — larger = more specific
  data: IpEnrichment;
}

/** Parse an IPv4 string to an unsigned 32-bit integer, or null if invalid. */
export function ipv4ToInt(ip: string): number | null {
  const parts = ip.trim().split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const o = Number(p);
    if (o > 255) return null;
    n = n * 256 + o;
  }
  return n >>> 0;
}

/** Parse an IPv4 CIDR (or bare IPv4 = /32) to an inclusive integer range. */
export function parseCidr(cidr: string): { start: number; end: number; prefix: number } | null {
  const [addr, prefixStr] = cidr.trim().split("/");
  const base = ipv4ToInt(addr);
  if (base === null) return null;
  const prefix = prefixStr === undefined ? 32 : Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 32) return null;
  // Mask: top `prefix` bits. prefix 0 → whole space; 32 → single host.
  const hostBits = 32 - prefix;
  const mask = prefix === 0 ? 0 : (0xffffffff << hostBits) >>> 0;
  const start = (base & mask) >>> 0;
  const end = (start + (hostBits === 32 ? 0xffffffff : (1 << hostBits) - 1)) >>> 0;
  return { start, end, prefix };
}

/** Parse an IPv6 string to a 128-bit BigInt, or null if invalid. Handles
 *  `::` zero-compression and a trailing IPv4-mapped tail (`::ffff:1.2.3.4`). */
export function ipv6ToBigInt(ip: string): bigint | null {
  let s = ip.trim();
  if (s === "" || s.includes(":::")) return null;
  // A trailing embedded IPv4 (e.g. ::ffff:1.2.3.4) → two hextets.
  const lastColon = s.lastIndexOf(":");
  if (s.slice(lastColon + 1).includes(".")) {
    const v4 = ipv4ToInt(s.slice(lastColon + 1));
    if (v4 === null) return null;
    const hi = (v4 >>> 16) & 0xffff;
    const lo = v4 & 0xffff;
    s = s.slice(0, lastColon + 1) + hi.toString(16) + ":" + lo.toString(16);
  }

  const halves = s.split("::");
  if (halves.length > 2) return null; // at most one "::"
  const parseGroups = (part: string): number[] | null => {
    if (part === "") return [];
    const groups = part.split(":");
    const out: number[] = [];
    for (const g of groups) {
      if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
      out.push(parseInt(g, 16));
    }
    return out;
  };

  let hextets: number[];
  if (halves.length === 2) {
    const left = parseGroups(halves[0]);
    const right = parseGroups(halves[1]);
    if (left === null || right === null) return null;
    const fill = 8 - left.length - right.length;
    if (fill < 1) return null; // "::" must stand for at least one zero group
    hextets = [...left, ...Array(fill).fill(0), ...right];
  } else {
    const all = parseGroups(s);
    if (all === null) return null;
    hextets = all;
  }
  if (hextets.length !== 8) return null;

  let n = 0n;
  for (const h of hextets) n = (n << 16n) | BigInt(h);
  return n;
}

/** Parse an IPv6 CIDR (or bare IPv6 = /128) to an inclusive BigInt range. */
export function parseCidr6(cidr: string): { start: bigint; end: bigint; prefix: number } | null {
  const [addr, prefixStr] = cidr.trim().split("/");
  const base = ipv6ToBigInt(addr);
  if (base === null) return null;
  const prefix = prefixStr === undefined ? 128 : Number(prefixStr);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > 128) return null;
  const hostBits = BigInt(128 - prefix);
  const full = (1n << 128n) - 1n;
  const mask = prefix === 0 ? 0n : (full << hostBits) & full;
  const start = base & mask;
  const end = start | ((1n << hostBits) - 1n);
  return { start, end, prefix };
}

export class IpEnrichmentDataset {
  private ranges: Range[] = [];
  private ranges6: Range6[] = [];
  /** Rows that couldn't be parsed (bad CIDR, malformed) — surfaced for diagnostics. */
  readonly skipped: number;
  readonly size: number;

  private constructor(ranges: Range[], ranges6: Range6[], skipped: number) {
    // Sort by start asc; lookup picks the most specific (largest prefix)
    // containing range so nested/overlapping rows resolve deterministically.
    this.ranges = ranges.sort((a, b) => a.start - b.start || a.end - b.end);
    this.ranges6 = ranges6.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : a.end < b.end ? -1 : a.end > b.end ? 1 : 0));
    this.skipped = skipped;
    this.size = ranges.length + ranges6.length;
  }

  static fromCsv(text: string): IpEnrichmentDataset {
    const ranges: Range[] = [];
    const ranges6: Range6[] = [];
    let skipped = 0;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const cells = line.split(",").map((c) => c.trim());
      if (cells[0].toLowerCase() === "network") continue; // header
      const data: IpEnrichment = {};
      if (cells[1]) data.country = cells[1];
      if (cells[2]) data.city = cells[2];
      if (cells[3]) data.asn = cells[3];
      if (cells[4]) data.org = cells[4];
      if (cells[5] !== undefined && cells[5] !== "") {
        data.hosting = ["true", "1", "yes"].includes(cells[5].toLowerCase());
      }
      // Route by family: a ':' in the network cell means IPv6.
      if (cells[0].includes(":")) {
        const r6 = parseCidr6(cells[0]);
        if (!r6) { skipped++; continue; }
        ranges6.push({ start: r6.start, end: r6.end, prefix: r6.prefix, data });
      } else {
        const r = parseCidr(cells[0]);
        if (!r) { skipped++; continue; }
        ranges.push({ start: r.start, end: r.end, prefix: r.prefix, data });
      }
    }
    return new IpEnrichmentDataset(ranges, ranges6, skipped);
  }

  /** Look up an IPv4 or IPv6 string. Returns the most specific matching row, or null. */
  lookup(ip: string): IpEnrichment | null {
    return ip.includes(":") ? this.lookup6(ip) : this.lookup4(ip);
  }

  private lookup4(ip: string): IpEnrichment | null {
    const n = ipv4ToInt(ip);
    if (n === null) return null;
    let best: Range | null = null;
    // Linear scan is fine for the dataset sizes this is meant for (curated
    // ranges of interest, not a full global table). Pick the most specific
    // (largest prefix) range that contains the IP.
    for (const r of this.ranges) {
      if (r.start > n) break; // sorted by start asc — all remaining ranges start after n
      if (n <= r.end && (best === null || r.prefix > best.prefix)) best = r;
    }
    return best ? { ...best.data } : null;
  }

  private lookup6(ip: string): IpEnrichment | null {
    const n = ipv6ToBigInt(ip);
    if (n === null) return null;
    let best: Range6 | null = null;
    for (const r of this.ranges6) {
      if (r.start > n) break; // sorted by start asc
      if (n <= r.end && (best === null || r.prefix > best.prefix)) best = r;
    }
    return best ? { ...best.data } : null;
  }
}
