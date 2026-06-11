// SCIM 2.0 list query: filter + pagination (RFC 7644 §3.4.2).
//
// Identity providers (Entra, Okta) reconcile by issuing
//   GET /Users?filter=userName eq "alice@example.com"
// and page large directories with startIndex/count. Without filter support a
// provider has to pull the whole list and match client-side — slow and, for
// Okta, a hard requirement. We support the `eq` operator on top-level string
// attributes (userName, displayName, externalId, id) plus `active eq true`,
// which covers what Entra/Okta actually send. Other operators are reported as
// unsupported (400) rather than silently returning everything — silence here
// would make a provider think "no match" when it means "not implemented".

export interface ScimFilter {
  attr: string;
  op: "eq";
  /** Comparison value: a string, or a boolean for `active eq true`. */
  value: string | boolean;
}

/** Parse a SCIM `filter` expression. Returns null for an empty/absent filter,
 *  or throws {unsupported:true} for a syntactically-valid filter we don't
 *  implement (a non-eq operator) so the caller can answer 400, not 200. */
export function parseScimFilter(raw: string | undefined): ScimFilter | null {
  if (!raw || !raw.trim()) return null;
  const s = raw.trim();
  // <attr> eq "value"   |   <attr> eq true|false
  const m = /^([A-Za-z][\w.]*)\s+(eq)\s+(?:"([^"]*)"|(true|false))$/i.exec(s);
  if (!m) {
    // Either an unsupported operator (co, sw, gt, …) or malformed. Signal
    // unsupported so the route returns 400 instead of an all-rows 200.
    const err = new Error(`Unsupported or malformed SCIM filter: ${raw}`);
    (err as { scimUnsupported?: boolean }).scimUnsupported = true;
    throw err;
  }
  const attr = m[1];
  const value = m[3] !== undefined ? m[3] : m[4].toLowerCase() === "true";
  return { attr, op: "eq", value };
}

/** Read a top-level attribute off a SCIM resource for `eq` comparison.
 *  Only flat attributes are supported (userName/displayName/externalId/id/
 *  active) — nested paths (name.familyName) aren't part of the eq surface. */
function attrValue(resource: Record<string, unknown>, attr: string): unknown {
  // Case-insensitive attribute match per the SCIM spec (attribute names are
  // case-insensitive); providers send `userName`, some send `username`.
  const key = Object.keys(resource).find((k) => k.toLowerCase() === attr.toLowerCase());
  return key ? resource[key] : undefined;
}

export interface ScimListResult<T> {
  resources: T[];
  totalResults: number;
  startIndex: number;
  itemsPerPage: number;
}

/**
 * Apply a SCIM `eq` filter + startIndex/count pagination to a resource list.
 * `filter`/`startIndex`/`count` are the raw query-string values.
 *
 * - filter: only `eq` (string, case-insensitive; or boolean for `active`).
 * - startIndex: 1-based (SCIM); clamped to >= 1; default 1.
 * - count: page size; clamped to [0, 1000]; absent → all remaining.
 *
 * Throws a {scimUnsupported:true} error for a non-eq filter so the route can
 * return 400 rather than a misleading full list.
 */
export function applyScimList<T extends Record<string, unknown>>(
  all: T[],
  q: { filter?: string; startIndex?: string; count?: string },
): ScimListResult<T> {
  const filter = parseScimFilter(q.filter);
  let filtered = all;
  if (filter) {
    filtered = all.filter((r) => {
      const v = attrValue(r, filter.attr);
      if (typeof filter.value === "boolean") return Boolean(v) === filter.value;
      // String eq is case-insensitive per the SCIM spec for these attrs.
      return v !== undefined && String(v).toLowerCase() === filter.value.toLowerCase();
    });
  }

  const total = filtered.length;
  const startIndex = Math.max(1, Number.parseInt(q.startIndex ?? "1", 10) || 1);
  const from = startIndex - 1;
  const rawCount = q.count === undefined ? undefined : Number.parseInt(q.count, 10);
  const count =
    rawCount === undefined || Number.isNaN(rawCount)
      ? undefined
      : Math.min(1000, Math.max(0, rawCount));
  const page = count === undefined ? filtered.slice(from) : filtered.slice(from, from + count);

  return { resources: page, totalResults: total, startIndex, itemsPerPage: page.length };
}
