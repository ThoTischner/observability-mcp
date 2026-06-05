// SSO vendor presets.
//
// Each profile preconfigures the OIDC fields that differ between
// well-known providers (scopes, claim paths for roles/groups, default
// logout URL pattern). The operator still provides issuer / clientId
// / redirectUri / clientSecret via env; the profile fills in the rest
// so a typical Entra or Okta rollout doesn't need a custom config.
//
// Explicit env vars ALWAYS override profile defaults — profiles are
// best-effort defaults, never a hard override.

export interface VendorProfile {
  /** Profile id, matches OMCP_OIDC_PROFILE. */
  readonly name: string;
  /** Human-readable label for logs + UI. */
  readonly label: string;
  /** Default OAuth scopes. */
  readonly scopes: string;
  /** Dotted claim path the IdP puts the user's group/role list under. */
  readonly rolesClaim: string;
  /** Default dotted claim path for tenant identification. Empty = all
   *  sessions land in the default tenant (operators usually leave
   *  this off unless they really do multi-tenant federation). */
  readonly tenantClaim: string;
  /** Doc URL deep-linked from the boot log on misconfiguration. */
  readonly docs: string;
}

const PROFILES: Record<string, VendorProfile> = {
  // Generic OIDC — the existing behaviour (matches Keycloak, Authentik,
  // Auth0, and any compliant provider that uses standard claims).
  generic: {
    name: "generic",
    label: "Generic OIDC",
    scopes: "openid profile email",
    rolesClaim: "groups",
    tenantClaim: "",
    docs: "docs/auth-oidc.md",
  },
  // Keycloak ships groups under "groups" or "realm_access.roles"
  // depending on mapper config. Default to "groups" to match the
  // out-of-the-box realm export the demo profile uses.
  keycloak: {
    name: "keycloak",
    label: "Keycloak",
    scopes: "openid profile email",
    rolesClaim: "groups",
    tenantClaim: "",
    // The existing OIDC reference covers Keycloak end-to-end (the
    // demo profile ships a Keycloak realm export). A dedicated
    // per-vendor page would duplicate it.
    docs: "docs/auth-oidc.md",
  },
  // GitHub does not expose groups natively in its OIDC tokens; the
  // common pattern is to use the "Teams" mapper or a custom claim
  // provider. We default to "groups" so an operator who sets up a
  // mapper sees their roles flow through; if they use a different
  // claim, OMCP_OIDC_ROLES_CLAIM still overrides.
  github: {
    name: "github",
    label: "GitHub",
    scopes: "openid profile email read:org",
    rolesClaim: "groups",
    tenantClaim: "",
    docs: "docs/auth-oidc-providers/github.md",
  },
  // Google Workspace exposes group membership via the "groups" claim
  // when the directory API consent is granted; otherwise treat it as
  // a single-user case (no group → no role mapping → user inherits
  // the OIDC default role).
  google: {
    name: "google",
    label: "Google Workspace",
    scopes: "openid profile email",
    rolesClaim: "groups",
    tenantClaim: "hd", // "hd" = hosted domain, useful as a tenant key
    docs: "docs/auth-oidc-providers/google.md",
  },
  // Microsoft Entra ID (formerly Azure AD) puts group IDs (object IDs)
  // under "groups". For >200 groups it switches to a graph link
  // claim — operators in that case must use a custom claim mapping
  // policy; documented in the per-vendor doc.
  "microsoft-entra": {
    name: "microsoft-entra",
    label: "Microsoft Entra ID",
    scopes: "openid profile email",
    rolesClaim: "groups",
    tenantClaim: "tid", // "tid" = tenant id (Entra-native)
    docs: "docs/auth-oidc-providers/microsoft-entra.md",
  },
  // Okta exposes groups via the "groups" claim when an OIDC Group
  // claim mapper is added (default for any non-trivial app).
  okta: {
    name: "okta",
    label: "Okta",
    scopes: "openid profile email groups",
    rolesClaim: "groups",
    tenantClaim: "",
    docs: "docs/auth-oidc-providers/okta.md",
  },
};

/** Returns the profile or undefined. Case-insensitive. */
export function getProfile(name: string | undefined): VendorProfile | undefined {
  if (!name) return undefined;
  return PROFILES[name.toLowerCase()];
}

/** All known profile names, useful for help text + the boot log. */
export function profileNames(): string[] {
  return Object.keys(PROFILES);
}

/** Default profile = generic (matches pre-F6 behaviour exactly). */
export const DEFAULT_PROFILE: VendorProfile = PROFILES.generic;
