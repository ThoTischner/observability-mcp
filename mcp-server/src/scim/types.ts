// SCIM 2.0 — minimal shared types.
//
// The gateway implements the subset of SCIM 2.0 that the most-common
// IdPs (Entra ID, Okta) use to provision Users and Groups. We do NOT
// aim for full RFC 7643 / 7644 compliance — only the methods the
// provisioning checklists exercise:
//
//   Users:   GET (list+by-id), POST, PATCH, DELETE
//   Groups:  GET (list+by-id), POST, PATCH, DELETE
//   Discovery: ServiceProviderConfig, ResourceTypes, Schemas
//
// Other operations (PUT/replace, Bulk, search-via-POST) are deferred
// until an IdP customer explicitly requires them.

export const SCIM_SCHEMA_USER = "urn:ietf:params:scim:schemas:core:2.0:User";
export const SCIM_SCHEMA_GROUP = "urn:ietf:params:scim:schemas:core:2.0:Group";
export const SCIM_SCHEMA_PATCH_OP = "urn:ietf:params:scim:api:messages:2.0:PatchOp";
export const SCIM_SCHEMA_LIST_RESPONSE = "urn:ietf:params:scim:api:messages:2.0:ListResponse";
export const SCIM_SCHEMA_ERROR = "urn:ietf:params:scim:api:messages:2.0:Error";

export interface ScimMeta {
  resourceType: "User" | "Group";
  created: string;
  lastModified: string;
  location?: string;
  version?: string;
}

export interface ScimUser {
  schemas: string[];
  id: string;
  userName: string;
  active?: boolean;
  displayName?: string;
  name?: {
    givenName?: string;
    familyName?: string;
    formatted?: string;
  };
  emails?: Array<{ value: string; primary?: boolean; type?: string }>;
  /** SCIM `groups` is read-only — populated server-side from the
   *  group→members linkage. */
  groups?: Array<{ value: string; display?: string }>;
  externalId?: string;
  meta: ScimMeta;
}

export interface ScimGroup {
  schemas: string[];
  id: string;
  displayName: string;
  members?: Array<{ value: string; display?: string; type?: "User" | "Group" }>;
  externalId?: string;
  meta: ScimMeta;
}

export interface ScimListResponse<T> {
  schemas: string[];
  totalResults: number;
  Resources: T[];
  startIndex?: number;
  itemsPerPage?: number;
}

export interface ScimError {
  schemas: string[];
  status: string;
  scimType?: string;
  detail?: string;
}

export interface ScimPatchOperation {
  op: "add" | "remove" | "replace";
  path?: string;
  value?: unknown;
}

export interface ScimPatchRequest {
  schemas: string[];
  Operations: ScimPatchOperation[];
}

export function scimError(status: number, detail: string, scimType?: string): ScimError {
  return {
    schemas: [SCIM_SCHEMA_ERROR],
    status: String(status),
    scimType,
    detail,
  };
}

export function nowIso(): string {
  return new Date().toISOString();
}
