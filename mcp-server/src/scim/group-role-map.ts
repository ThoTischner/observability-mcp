// Translate SCIM-provisioned groups into the gateway's RBAC roles.
// Operators configure the mapping via OMCP_SCIM_GROUP_ROLE_MAP:
//
//   OMCP_SCIM_GROUP_ROLE_MAP="admins:admin,sre:operator,readers:viewer"
//
// A SCIM-managed user's groups[] (populated from group membership
// in the ScimStore) translates to a set of RBAC roles via this map,
// joining the OIDC group-mapping pattern from F6 so a federated
// IdP rolling Users + Groups via SCIM ends up with the same RBAC
// posture as a directly-claim-mapped login.

export function parseScimGroupRoleMap(raw: string | undefined): Map<string, string> {
  const out = new Map<string, string>();
  if (!raw) return out;
  for (const pair of raw.split(",")) {
    const [groupName, role] = pair.split(":").map((s) => s.trim());
    if (!groupName || !role) continue;
    out.set(groupName.toLowerCase(), role);
  }
  return out;
}

/** Map a user's group-display-names to the gateway's RBAC roles.
 *  Unknown groups are silently dropped (least-privilege). */
export function rolesForGroups(
  groupDisplayNames: string[],
  map: Map<string, string>,
): string[] {
  const out = new Set<string>();
  for (const g of groupDisplayNames) {
    const role = map.get(g.toLowerCase());
    if (role) out.add(role);
  }
  return [...out];
}
