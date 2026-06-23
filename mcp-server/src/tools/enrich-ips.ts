import { IpEnrichmentDataset, ipv4ToInt, ipv6ToBigInt } from "../enrich/ip-dataset.js";
import type { RdapResolver } from "../enrich/rdap.js";
import { defaultContext, type RequestContext } from "../context.js";
import { errorResponse } from "./validation.js";

// enrich_ips (issue #415 Gap B): resolve a batch of IPs to geo / ASN / org /
// hosting-flag from the operator's LOCAL offline dataset. No external lookups,
// so it is safe in air-gapped deployments. Disabled (returns a clear message)
// when no dataset is configured.

export const enrichIpsDefinition = {
  name: "enrich_ips" as const,
  description:
    "Resolve a batch of IPv4 or IPv6 addresses to geo (country/city), ASN/org, and a hosting/proxy flag from a local offline dataset. Use this to answer 'where are these visitors from / which are bots or datacenter IPs' without an out-of-band geo API call. Requires the operator to have configured an offline dataset (OMCP_IP_ENRICH_FILE); returns a clear notice otherwise.",
};

const MAX_IPS = 1000;

/** A string is a valid IP if it parses as either IPv4 or IPv6. */
function isValidIp(ip: string): boolean {
  return ipv4ToInt(ip) !== null || ipv6ToBigInt(ip) !== null;
}

export interface EnrichIpsArgs {
  ips?: string[];
}

export interface IpEnrichmentResult {
  ip: string;
  found: boolean;
  country?: string;
  city?: string;
  asn?: string;
  org?: string;
  hosting?: boolean;
  /** Which backend produced the hit — "dataset" (offline CSV) or "rdap"
   *  (online fallback). Absent when not found. */
  via?: "dataset" | "rdap";
  /** True when `found:false` is NOT a confirmed negative but an RDAP upstream
   *  failure (throttle/timeout/5xx) — the address may resolve on a later retry.
   *  Issue #523: never conflate a rate-limit with "not in any registry". */
  transient?: boolean;
  /** Machine-readable reason when `transient` — e.g. "rate_limited". */
  error?: string;
}

export async function enrichIpsHandler(
  dataset: IpEnrichmentDataset | null,
  args: EnrichIpsArgs,
  // The RequestContext seam — enrich_ips doesn't scope by tenant today (the
  // dataset is a single process-wide table), but every tool handler threads
  // ctx so access-control / audit can attach without a signature change later.
  _ctx: RequestContext = defaultContext(),
  // Optional online RDAP fallback (issue #477). Present only when the operator
  // set OMCP_IP_ENRICH_RDAP=on; absent → no external call (air-gapped default).
  rdap?: RdapResolver | null,
) {
  if (!dataset && !rdap) {
    return errorResponse(
      "IP enrichment is not configured. Set OMCP_IP_ENRICH_FILE to a local CSV " +
        "(network,country,city,asn,org,hosting) for offline lookups (air-gapped), " +
        "or OMCP_IP_ENRICH_RDAP=on for an online RDAP fallback (country/org only).",
    );
  }
  const ips = args.ips;
  if (!Array.isArray(ips) || ips.length === 0) {
    return errorResponse("`ips` must be a non-empty array of IPv4 or IPv6 address strings.");
  }
  if (ips.length > MAX_IPS) {
    return errorResponse(`Too many IPs (${ips.length}); max ${MAX_IPS} per call.`);
  }

  const results: IpEnrichmentResult[] = [];
  let invalid = 0;
  let matched = 0;
  let viaRdap = 0;
  let transient = 0;
  for (const ip of ips) {
    if (typeof ip !== "string" || !isValidIp(ip)) {
      invalid++;
      results.push({ ip: String(ip), found: false });
      continue;
    }
    // Offline CSV is preferred (city precision, air-gapped). RDAP only fills
    // gaps the dataset didn't cover, and only when the operator opted in.
    const hit = dataset ? dataset.lookup(ip) : null;
    if (hit) {
      matched++;
      results.push({ ip, found: true, via: "dataset", ...hit });
      continue;
    }
    if (rdap) {
      const r = await rdap.resolve(ip);
      if (r.status === "ok") {
        matched++;
        viaRdap++;
        results.push({ ip, found: true, via: "rdap", ...r.value });
        continue;
      }
      if (r.status === "transient") {
        // NOT a confirmed negative — an RDAP throttle/timeout/5xx. Mark it so an
        // agent doesn't treat the IP as "unknown" and can retry later (#523).
        transient++;
        results.push({ ip, found: false, transient: true, error: r.reason });
        continue;
      }
    }
    results.push({ ip, found: false });
  }

  // unmatched = confirmed negatives only; transient failures are reported
  // separately so the all-clear can't silently absorb a wall of rate-limits.
  const unmatched = ips.length - matched - invalid - transient;

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            results,
            summary: {
              total: ips.length,
              matched,
              unmatched,
              invalid,
              ...(rdap ? { viaRdap, transient } : {}),
            },
            datasetSize: dataset?.size ?? 0,
            ...(rdap ? { rdapEnabled: true } : {}),
            ...(transient > 0
              ? {
                  note:
                    `${transient} RDAP lookup(s) failed transiently (e.g. rate-limited by the ` +
                    `registry) and are marked transient:true — these are NOT confirmed negatives. ` +
                    `Retry them later or in a smaller batch; results are cached so repeats are cheap.`,
                }
              : {}),
          },
          null,
          2,
        ),
      },
    ],
  };
}
