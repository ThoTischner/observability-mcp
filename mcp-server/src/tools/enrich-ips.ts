import { IpEnrichmentDataset, ipv4ToInt, ipv6ToBigInt } from "../enrich/ip-dataset.js";
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
}

export function enrichIpsHandler(
  dataset: IpEnrichmentDataset | null,
  args: EnrichIpsArgs,
  // The RequestContext seam — enrich_ips doesn't scope by tenant today (the
  // dataset is a single process-wide table), but every tool handler threads
  // ctx so access-control / audit can attach without a signature change later.
  _ctx: RequestContext = defaultContext(),
) {
  if (!dataset) {
    return errorResponse(
      "IP enrichment is not configured. Set OMCP_IP_ENRICH_FILE to a local CSV " +
        "(network,country,city,asn,org,hosting) to enable offline geo/ASN/hosting " +
        "lookups — there is no external API call, so it stays air-gapped.",
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
  for (const ip of ips) {
    if (typeof ip !== "string" || !isValidIp(ip)) {
      invalid++;
      results.push({ ip: String(ip), found: false });
      continue;
    }
    const hit = dataset.lookup(ip);
    if (hit) {
      matched++;
      results.push({ ip, found: true, ...hit });
    } else {
      results.push({ ip, found: false });
    }
  }

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(
          {
            results,
            summary: { total: ips.length, matched, unmatched: ips.length - matched - invalid, invalid },
            datasetSize: dataset.size,
          },
          null,
          2,
        ),
      },
    ],
  };
}
