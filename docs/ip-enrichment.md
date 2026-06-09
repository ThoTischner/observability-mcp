# IP enrichment (`enrich_ips`)

Traffic / abuse / security investigations over access logs need the same
three things for each client IP: **geo** (country/city), **ASN/org**
(which network/ISP), and a **hosting/proxy flag** (the signal that
separates real humans from datacenter IPs, scanners, and VPN exit
nodes). The `enrich_ips` tool resolves a batch of IPs to those fields
from a **local, offline dataset** — there is no per-IP call to an
external geo API, so it works in air-gapped deployments.

## Enabling

Point the server at a local CSV:

```bash
OMCP_IP_ENRICH_FILE=/data/ip-enrichment.csv
```

When unset (the default), `enrich_ips` is still advertised but returns a
clear "not configured" notice — no external lookups ever happen
implicitly.

## Dataset format

A dependency-free CSV (so no parser library / host `npm install` is
needed). One row per IPv4 network:

```csv
network,country,city,asn,org,hosting
1.2.3.0/24,US,Ashburn,AS14618,Example Cloud,true
203.0.113.5,DE,Berlin,AS3320,Example ISP,false
```

- `network` — an IPv4 CIDR, or a bare IPv4 (treated as `/32`). IPv6 rows
  are skipped (logged at boot); IPv4 covers the access-log case.
- `country`, `city`, `asn`, `org` — optional; an empty cell is omitted
  from the result.
- `hosting` — `true`/`1`/`yes` (case-insensitive) marks a
  datacenter/hosting/proxy range; anything else is `false`.
- Blank lines and `#` comments are ignored; a header row whose first
  cell is `network` is skipped.

Overlapping/nested ranges resolve to the **most specific** (longest
prefix) match, so a `/24` row wins over a `/8` that also contains the
IP. The dataset is loaded once at boot and looked up in-memory.

You supply the data offline — e.g. export the ranges of interest from
whatever geo/ASN source you already license into this CSV and mount it.
This keeps enrichment air-gapped and avoids bundling any third-party
database into the image.

## Usage

```jsonc
{ "ips": ["203.0.113.5", "198.51.100.9", "1.2.3.99"] }
```

Returns one row per input IP (max 1000 per call); unmatched and invalid
IPs come back with `found: false` rather than failing the batch:

```jsonc
{
  "results": [
    { "ip": "1.2.3.99", "found": true, "country": "US", "city": "Ashburn",
      "asn": "AS14618", "org": "Example Cloud", "hosting": true },
    { "ip": "8.8.8.8", "found": false }
  ],
  "summary": { "total": 2, "matched": 1, "unmatched": 1, "invalid": 0 },
  "datasetSize": 1
}
```

A typical agent flow: pull the IPs of interest with `query_logs`
(use `labels` / `aggregate` to filter or top-k first), then pass them to
`enrich_ips` to answer "where from / which are bots".

## Air-gapped guarantee

`enrich_ips` never makes an outbound request — all data comes from the
local file. This is the deliberate trade vs. a live geo-API enrichment
on every log line, which would break the air-gapped deployment model.
