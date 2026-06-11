#!/usr/bin/env node
// build-ip-enrich-csv.mjs — turn a licensed MaxMind GeoLite2 export into the
// enrich_ips CSV (network,country,city,asn,org,hosting) that OMCP_IP_ENRICH_FILE
// expects. The geo/ASN DATA stays on the operator's machine — this only
// reshapes a file you already license; nothing is bundled into the image and
// there is no network call, so the air-gapped guarantee is preserved.
//
// Dependency-free (own RFC-4180 CSV parser — MaxMind org names contain commas),
// so it runs with plain `node` and needs no npm install. Handles IPv4 and IPv6.
//
// Usage:
//   node scripts/build-ip-enrich-csv.mjs \
//     --city-blocks GeoLite2-City-Blocks-IPv4.csv \
//     --city-blocks GeoLite2-City-Blocks-IPv6.csv \
//     --locations   GeoLite2-City-Locations-en.csv \
//     --asn-blocks  GeoLite2-ASN-Blocks-IPv4.csv \
//     --asn-blocks  GeoLite2-ASN-Blocks-IPv6.csv \
//     --out enrich.csv
//
// --city-blocks / --asn-blocks may be repeated (v4 + v6). --locations and the
// ASN files are optional: with only city blocks you get network,country,city;
// add ASN to fill asn/org. The `hosting` flag is left blank — GeoLite2 City/ASN
// don't carry it (it lives in the paid Anonymous-IP DB); set it yourself if you
// have that data. ASN is matched by each block's network address against the
// ASN range table (ASN ranges are coarser, so this is exact in practice).

import { readFileSync, writeFileSync } from "node:fs";

// ---- argv ----
function parseArgs(argv) {
  const out = { cityBlocks: [], asnBlocks: [], locations: null, out: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--city-blocks") out.cityBlocks.push(argv[++i]);
    else if (a === "--asn-blocks") out.asnBlocks.push(argv[++i]);
    else if (a === "--locations") out.locations = argv[++i];
    else if (a === "--out") out.out = argv[++i];
    else if (a === "--help" || a === "-h") out.help = true;
    else throw new Error(`unknown arg: ${a}`);
  }
  return out;
}

// ---- RFC-4180 CSV: handles "quoted, fields" with embedded commas/quotes ----
function parseCsvLine(line) {
  const cells = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQ) {
      if (c === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += c;
    } else if (c === '"') inQ = true;
    else if (c === ",") { cells.push(cur); cur = ""; }
    else cur += c;
  }
  cells.push(cur);
  return cells;
}

function* csvRows(text) {
  // Split on newlines outside quotes. MaxMind has no embedded newlines, so a
  // line-based split is safe and keeps memory low for large files.
  for (const raw of text.split(/\r?\n/)) {
    if (raw === "") continue;
    yield parseCsvLine(raw);
  }
}

function indexOfHeader(header, name) {
  const i = header.indexOf(name);
  if (i < 0) throw new Error(`column "${name}" not found (have: ${header.join(", ")})`);
  return i;
}

// ---- IP math (mirrors src/enrich/ip-dataset.ts; kept dependency-free here) ----
function ipv4ToInt(ip) {
  const p = ip.split(".");
  if (p.length !== 4) return null;
  let n = 0;
  for (const o of p) {
    if (!/^\d{1,3}$/.test(o) || +o > 255) return null;
    n = n * 256 + +o;
  }
  return n >>> 0;
}
function ipv6ToBigInt(ip) {
  let s = ip.trim();
  if (s === "" || s.includes(":::")) return null;
  const lc = s.lastIndexOf(":");
  if (s.slice(lc + 1).includes(".")) {
    const v4 = ipv4ToInt(s.slice(lc + 1));
    if (v4 === null) return null;
    s = s.slice(0, lc + 1) + ((v4 >>> 16) & 0xffff).toString(16) + ":" + (v4 & 0xffff).toString(16);
  }
  const halves = s.split("::");
  if (halves.length > 2) return null;
  const groups = (part) => {
    if (part === "") return [];
    const g = part.split(":");
    const o = [];
    for (const x of g) { if (!/^[0-9a-fA-F]{1,4}$/.test(x)) return null; o.push(parseInt(x, 16)); }
    return o;
  };
  let hex;
  if (halves.length === 2) {
    const l = groups(halves[0]); const r = groups(halves[1]);
    if (l === null || r === null) return null;
    const fill = 8 - l.length - r.length;
    if (fill < 1) return null;
    hex = [...l, ...Array(fill).fill(0), ...r];
  } else { const all = groups(s); if (all === null) return null; hex = all; }
  if (hex.length !== 8) return null;
  let n = 0n;
  for (const h of hex) n = (n << 16n) | BigInt(h);
  return n;
}
/** Start address of a network as a comparable BigInt (v4 mapped into v6 space-agnostic key). */
function netKey(network) {
  if (network.includes(":")) {
    const base = ipv6ToBigInt(network.split("/")[0]);
    return base === null ? null : { v6: true, key: base };
  }
  const base = ipv4ToInt(network.split("/")[0]);
  return base === null ? null : { v6: false, key: BigInt(base) };
}

// ---- ASN range table for network-start lookup ----
function buildAsnRanges(files) {
  const v4 = []; const v6 = [];
  for (const f of files) {
    const text = readFileSync(f, "utf8");
    const it = csvRows(text);
    const header = it.next().value;
    const netI = indexOfHeader(header, "network");
    const asnI = indexOfHeader(header, "autonomous_system_number");
    const orgI = indexOfHeader(header, "autonomous_system_organization");
    for (const row of it) {
      const network = row[netI];
      if (!network) continue;
      const k = netKey(network);
      if (!k) continue;
      const rec = { start: k.key, asn: row[asnI] ? `AS${row[asnI]}` : "", org: row[orgI] || "" };
      (k.v6 ? v6 : v4).push(rec);
    }
  }
  v4.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  v6.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0));
  return { v4, v6 };
}
/** Largest range start <= key (binary search) — the ASN block containing the address. */
function asnFor(ranges, v6, key) {
  const arr = v6 ? ranges.v6 : ranges.v4;
  let lo = 0, hi = arr.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid].start <= key) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans >= 0 ? arr[ans] : null;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.cityBlocks.length === 0 || !args.out) {
    console.error("usage: build-ip-enrich-csv.mjs --city-blocks <f>[ --city-blocks <f6>] [--locations <f>] [--asn-blocks <f>...] --out <f>");
    process.exit(args.help ? 0 : 2);
  }

  // locations: geoname_id → {country, city}
  const loc = new Map();
  if (args.locations) {
    const text = readFileSync(args.locations, "utf8");
    const it = csvRows(text);
    const header = it.next().value;
    const idI = indexOfHeader(header, "geoname_id");
    const ccI = indexOfHeader(header, "country_iso_code");
    const cityI = indexOfHeader(header, "city_name");
    for (const row of it) {
      if (!row[idI]) continue;
      loc.set(row[idI], { country: row[ccI] || "", city: row[cityI] || "" });
    }
  }

  const asn = args.asnBlocks.length ? buildAsnRanges(args.asnBlocks) : null;

  const escapeCell = (v) => (v.includes(",") || v.includes('"') ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = ["network,country,city,asn,org,hosting"];
  let rows = 0;

  for (const f of args.cityBlocks) {
    const text = readFileSync(f, "utf8");
    const it = csvRows(text);
    const header = it.next().value;
    const netI = indexOfHeader(header, "network");
    const geoI = indexOfHeader(header, "geoname_id");
    for (const row of it) {
      const network = row[netI];
      if (!network) continue;
      const k = netKey(network);
      if (!k) continue;
      const g = loc.get(row[geoI]) || { country: "", city: "" };
      let a = { asn: "", org: "" };
      if (asn) { const hit = asnFor(asn, k.v6, k.key); if (hit) a = hit; }
      lines.push([network, g.country, g.city, a.asn, a.org, ""].map(escapeCell).join(","));
      rows++;
    }
  }

  writeFileSync(args.out, lines.join("\n") + "\n");
  console.error(`wrote ${rows} rows to ${args.out}${asn ? " (with ASN/org)" : " (geo only — pass --asn-blocks to add ASN)"}`);
}

main();
