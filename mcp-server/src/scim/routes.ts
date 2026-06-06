// SCIM 2.0 routes — mounted at /scim/v2/.
//
// Spec subset covered:
//   GET    /scim/v2/ServiceProviderConfig
//   GET    /scim/v2/ResourceTypes
//   GET    /scim/v2/Schemas
//   GET    /scim/v2/Users        list (no filter support yet)
//   GET    /scim/v2/Users/:id
//   POST   /scim/v2/Users
//   PATCH  /scim/v2/Users/:id    minimal: replace top-level attrs
//   DELETE /scim/v2/Users/:id
//   GET    /scim/v2/Groups
//   GET    /scim/v2/Groups/:id
//   POST   /scim/v2/Groups
//   PATCH  /scim/v2/Groups/:id
//   DELETE /scim/v2/Groups/:id
//
// Auth: Bearer token via OMCP_SCIM_TOKEN; absence of OMCP_SCIM_TOKEN
// rejects every request (the routes are not safe without it).

import type { Application, Request, Response, NextFunction } from "express";
import { timingSafeEqual } from "node:crypto";

import {
  SCIM_SCHEMA_LIST_RESPONSE,
  SCIM_SCHEMA_USER,
  SCIM_SCHEMA_GROUP,
  scimError,
  type ScimUser,
  type ScimGroup,
  type ScimPatchRequest,
} from "./types.js";
import { ScimNotFoundError, type IScimStore, ScimValidationError } from "./store.js";

export interface ScimRoutesDeps {
  store: IScimStore;
  bearerToken: string;
  /** Audit hook called after every successful mutation. Best-effort. */
  audit?: (event: { actor: string; action: string; target: string; result: "ok" | "error"; status: number }) => void;
}

const constantTimeBearerMatch = (raw: string | undefined, expected: string): boolean => {
  if (!raw) return false;
  // Use bounded whitespace ({1,16}) instead of `\s+` to avoid the
  // polynomial-ReDoS class — `\s+` followed by `(.+)` backtracks on
  // strings like "bearer<many spaces><payload>". 16 is generous;
  // RFC 7235 only requires one space.
  const m = raw.match(/^Bearer[ \t]{1,16}(.+)$/i);
  if (!m) return false;
  const a = Buffer.from(m[1].trim());
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
};

export function registerScimRoutes(app: Application, deps: ScimRoutesDeps): void {
  const { store, bearerToken, audit } = deps;

  // Auth middleware — scoped to /scim/v2/* only.
  app.use("/scim/v2", (req: Request, res: Response, next: NextFunction) => {
    if (!bearerToken) {
      res.status(503).json(scimError(503, "SCIM is enabled but OMCP_SCIM_TOKEN is unset"));
      return;
    }
    if (!constantTimeBearerMatch(req.headers["authorization"] as string | undefined, bearerToken)) {
      res.status(401).json(scimError(401, "valid SCIM bearer token required"));
      return;
    }
    next();
  });

  // ---- Discovery endpoints ----
  app.get("/scim/v2/ServiceProviderConfig", (_req, res) => {
    res.json({
      schemas: ["urn:ietf:params:scim:schemas:core:2.0:ServiceProviderConfig"],
      documentationUri: "https://thotischner.github.io/observability-mcp/scim-provisioning/",
      patch: { supported: true },
      bulk: { supported: false, maxOperations: 0, maxPayloadSize: 0 },
      filter: { supported: false, maxResults: 200 },
      changePassword: { supported: false },
      sort: { supported: false },
      etag: { supported: false },
      authenticationSchemes: [
        {
          name: "OAuth Bearer Token",
          description: "Authentication via OAuth 2.0 bearer token (configured per-deployment).",
          specUri: "https://datatracker.ietf.org/doc/html/rfc6750",
          documentationUri: "https://thotischner.github.io/observability-mcp/scim-provisioning/",
          type: "oauthbearertoken",
          primary: true,
        },
      ],
    });
  });

  app.get("/scim/v2/ResourceTypes", (_req, res) => {
    res.json({
      schemas: [SCIM_SCHEMA_LIST_RESPONSE],
      totalResults: 2,
      Resources: [
        {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
          id: "User",
          name: "User",
          endpoint: "/Users",
          description: "User account",
          schema: SCIM_SCHEMA_USER,
        },
        {
          schemas: ["urn:ietf:params:scim:schemas:core:2.0:ResourceType"],
          id: "Group",
          name: "Group",
          endpoint: "/Groups",
          description: "Group / role mapping",
          schema: SCIM_SCHEMA_GROUP,
        },
      ],
    });
  });

  app.get("/scim/v2/Schemas", (_req, res) => {
    res.json({
      schemas: [SCIM_SCHEMA_LIST_RESPONSE],
      totalResults: 2,
      Resources: [
        { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"], id: SCIM_SCHEMA_USER, name: "User" },
        { schemas: ["urn:ietf:params:scim:schemas:core:2.0:Schema"], id: SCIM_SCHEMA_GROUP, name: "Group" },
      ],
    });
  });

  // ---- Users ----
  app.get("/scim/v2/Users", (_req, res) => {
    const users = store.listUsers().map((u) => withGroups(u, store));
    res.json({
      schemas: [SCIM_SCHEMA_LIST_RESPONSE],
      totalResults: users.length,
      itemsPerPage: users.length,
      startIndex: 1,
      Resources: users,
    });
  });

  app.get("/scim/v2/Users/:id", (req, res) => {
    const u = store.getUser(req.params.id);
    if (!u) {
      res.status(404).json(scimError(404, `User ${req.params.id} not found`));
      return;
    }
    res.json(withGroups(u, store));
  });

  app.post("/scim/v2/Users", async (req, res) => {
    try {
      const u = await store.createUser((req.body ?? {}) as Partial<ScimUser>);
      audit?.({ actor: "scim", action: "User.create", target: u.userName, result: "ok", status: 201 });
      res.status(201).json(withGroups(u, store));
    } catch (e) {
      handleStoreError(e, res, "User.create", audit);
    }
  });

  app.patch("/scim/v2/Users/:id", async (req, res) => {
    try {
      const patch = applyPatchOps(store.getUser(req.params.id), req.body as ScimPatchRequest);
      const u = await store.updateUser(req.params.id, patch);
      audit?.({ actor: "scim", action: "User.update", target: u.userName, result: "ok", status: 200 });
      res.json(withGroups(u, store));
    } catch (e) {
      handleStoreError(e, res, "User.update", audit);
    }
  });

  app.delete("/scim/v2/Users/:id", async (req, res) => {
    const ok = await store.deleteUser(req.params.id);
    audit?.({ actor: "scim", action: "User.delete", target: req.params.id, result: ok ? "ok" : "error", status: ok ? 204 : 404 });
    if (!ok) {
      res.status(404).json(scimError(404, `User ${req.params.id} not found`));
      return;
    }
    res.status(204).end();
  });

  // ---- Groups ----
  app.get("/scim/v2/Groups", (_req, res) => {
    const groups = store.listGroups();
    res.json({
      schemas: [SCIM_SCHEMA_LIST_RESPONSE],
      totalResults: groups.length,
      itemsPerPage: groups.length,
      startIndex: 1,
      Resources: groups,
    });
  });

  app.get("/scim/v2/Groups/:id", (req, res) => {
    const g = store.getGroup(req.params.id);
    if (!g) {
      res.status(404).json(scimError(404, `Group ${req.params.id} not found`));
      return;
    }
    res.json(g);
  });

  app.post("/scim/v2/Groups", async (req, res) => {
    try {
      const g = await store.createGroup((req.body ?? {}) as Partial<ScimGroup>);
      audit?.({ actor: "scim", action: "Group.create", target: g.displayName, result: "ok", status: 201 });
      res.status(201).json(g);
    } catch (e) {
      handleStoreError(e, res, "Group.create", audit);
    }
  });

  app.patch("/scim/v2/Groups/:id", async (req, res) => {
    try {
      const patch = applyPatchOps(store.getGroup(req.params.id), req.body as ScimPatchRequest);
      const g = await store.updateGroup(req.params.id, patch);
      audit?.({ actor: "scim", action: "Group.update", target: g.displayName, result: "ok", status: 200 });
      res.json(g);
    } catch (e) {
      handleStoreError(e, res, "Group.update", audit);
    }
  });

  app.delete("/scim/v2/Groups/:id", async (req, res) => {
    const ok = await store.deleteGroup(req.params.id);
    audit?.({ actor: "scim", action: "Group.delete", target: req.params.id, result: ok ? "ok" : "error", status: ok ? 204 : 404 });
    if (!ok) {
      res.status(404).json(scimError(404, `Group ${req.params.id} not found`));
      return;
    }
    res.status(204).end();
  });
}

function withGroups(u: ScimUser, store: IScimStore): ScimUser {
  return { ...u, groups: store.groupsContaining(u.id) };
}

/** Translate a SCIM PatchOp into a partial resource patch. Minimal:
 *  we accept `op: "replace"` with no path (whole-resource merge) or
 *  with a single-segment path naming a top-level attribute. `add` and
 *  `remove` for members/emails arrays are a follow-up — the
 *  Entra/Okta provisioning checklists exercise replace-only on the
 *  attributes we expose. */
// Allow-list of attribute names patchable via SCIM PatchOp.
// `applyPatchOps` writes into a plain object using a user-supplied
// path/key — every key is gated through this set so a malicious
// client can't inject __proto__ / constructor / arbitrary fields.
const PATCH_ALLOWED_ATTRS: ReadonlySet<string> = new Set([
  "userName", "active", "displayName", "name", "emails", "externalId",
  "members", "groups",
]);

function safePatchKey(k: unknown): k is string {
  return typeof k === "string" && PATCH_ALLOWED_ATTRS.has(k);
}

/** Translate a SCIM PatchOp into a partial resource patch. Minimal:
 *  we accept `op: "replace"` with no path (whole-resource merge) or
 *  with a single-segment path naming a top-level attribute. `add` and
 *  `remove` for members/emails arrays are a follow-up — the
 *  Entra/Okta provisioning checklists exercise replace-only on the
 *  attributes we expose.
 *
 *  Every property name written into `out` is gated through
 *  `PATCH_ALLOWED_ATTRS` so a SCIM client can't inject __proto__ /
 *  constructor / arbitrary fields (CodeQL js/remote-property-injection +
 *  js/prototype-polluting-assignment). */
function applyPatchOps<T extends { id: string }>(current: T | undefined, patch: ScimPatchRequest): Partial<T> {
  if (!current) throw new ScimNotFoundError("target resource not found");
  if (!patch?.Operations || !Array.isArray(patch.Operations)) return {};
  const out: Record<string, unknown> = {};
  for (const op of patch.Operations) {
    if (op.op !== "replace") continue; // skip add/remove for F21a
    if (!op.path) {
      if (op.value && typeof op.value === "object") {
        for (const [k, v] of Object.entries(op.value as Record<string, unknown>)) {
          if (safePatchKey(k)) out[k] = v;
        }
      }
      continue;
    }
    if (safePatchKey(op.path)) out[op.path] = op.value;
  }
  return out as Partial<T>;
}

function handleStoreError(e: unknown, res: Response, action: string, audit?: ScimRoutesDeps["audit"]): void {
  if (e instanceof ScimNotFoundError) {
    audit?.({ actor: "scim", action, target: "?", result: "error", status: 404 });
    res.status(404).json(scimError(404, e.message));
    return;
  }
  if (e instanceof ScimValidationError) {
    const status = e.scimType === "uniqueness" ? 409 : 400;
    audit?.({ actor: "scim", action, target: "?", result: "error", status });
    res.status(status).json(scimError(status, e.message, e.scimType));
    return;
  }
  console.warn(`[scim] ${action} failed:`, e);
  audit?.({ actor: "scim", action, target: "?", result: "error", status: 500 });
  res.status(500).json(scimError(500, "internal error"));
}
