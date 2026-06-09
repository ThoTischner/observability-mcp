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
// - `network` is an IPv4 CIDR (or a bare IPv4, treated as /32). IPv6 rows are
//   skipped (logged by the caller) — IPv4 covers the access-log case the
//   report was about; IPv6 can follow.
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

export class IpEnrichmentDataset {
  private ranges: Range[] = [];
  /** Rows that couldn't be parsed (bad CIDR, IPv6, malformed) — surfaced for diagnostics. */
  readonly skipped: number;
  readonly size: number;

  private constructor(ranges: Range[], skipped: number) {
    // Sort by start asc; lookup picks the most specific (largest prefix)
    // containing range so nested/overlapping rows resolve deterministically.
    this.ranges = ranges.sort((a, b) => a.start - b.start || a.end - b.end);
    this.skipped = skipped;
    this.size = ranges.length;
  }

  static fromCsv(text: string): IpEnrichmentDataset {
    const ranges: Range[] = [];
    let skipped = 0;
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const cells = line.split(",").map((c) => c.trim());
      if (cells[0].toLowerCase() === "network") continue; // header
      const r = parseCidr(cells[0]);
      if (!r) {
        skipped++;
        continue;
      }
      const data: IpEnrichment = {};
      if (cells[1]) data.country = cells[1];
      if (cells[2]) data.city = cells[2];
      if (cells[3]) data.asn = cells[3];
      if (cells[4]) data.org = cells[4];
      if (cells[5] !== undefined && cells[5] !== "") {
        data.hosting = ["true", "1", "yes"].includes(cells[5].toLowerCase());
      }
      ranges.push({ start: r.start, end: r.end, prefix: r.prefix, data });
    }
    return new IpEnrichmentDataset(ranges, skipped);
  }

  /** Look up an IPv4 string. Returns the most specific matching row, or null. */
  lookup(ip: string): IpEnrichment | null {
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
}
