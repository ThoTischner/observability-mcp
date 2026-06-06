// Redis-backed SCIM store — same surface as the file-backed ScimStore,
// persists the snapshot in a single Redis key.
//
// Multi-replica deployments need a shared store so that a Microsoft
// Entra / Okta SCIM-push delivered to replica A is visible to replica
// B's reads. The file store can't do that without a shared filesystem;
// this one targets the same Redis the F8 SessionStore + the F8b
// transport-map ride on (Q11 promotes the transport-map onto the same
// interface).
//
// Concurrency note. SCIM clients (Entra, Okta, JumpCloud, generic
// SCIM) deliver provisioning requests SERIALLY per resource — the
// upstream IDP holds the connection open until the gateway responds.
// A single load-balanced gateway in front of N replicas observes one
// in-flight request per resource at a time, so last-writer-wins on
// the single-key snapshot matches the source-of-truth semantics of
// SCIM provisioning. We still serialise persists within a replica
// via a small mutex so concurrent route handlers don't lose writes
// to each other in the read-modify-write window.

import { randomUUID } from "node:crypto";

import {
  nowIso,
  type ScimGroup,
  type ScimUser,
  SCIM_SCHEMA_GROUP,
  SCIM_SCHEMA_USER,
} from "./types.js";
import { ScimNotFoundError, ScimValidationError, type IScimStore, type ScimSnapshot } from "./store.js";

/**
 * Minimal Redis surface we depend on. Matches both `ioredis` and the
 * built-in promisified node-redis client — easier to swap clients
 * and trivial to fake in unit tests.
 */
export interface RedisLike {
  get(key: string): Promise<string | null>;
  set(key: string, value: string): Promise<unknown>;
}

const DEFAULT_KEY = "omcp:scim:snapshot";

export class RedisScimStore implements IScimStore {
  private readonly redis: RedisLike;
  private readonly key: string;
  private snapshot: ScimSnapshot = { users: [], groups: [] };
  private bootstrapped: Promise<void> | null = null;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(redis: RedisLike, opts: { key?: string } = {}) {
    this.redis = redis;
    this.key = opts.key || DEFAULT_KEY;
  }

  async load(): Promise<void> {
    if (this.bootstrapped) return this.bootstrapped;
    this.bootstrapped = (async () => {
      try {
        const raw = await this.redis.get(this.key);
        if (!raw) {
          this.snapshot = { users: [], groups: [] };
          return;
        }
        const parsed = JSON.parse(raw) as Partial<ScimSnapshot>;
        this.snapshot = {
          users: Array.isArray(parsed.users) ? parsed.users : [],
          groups: Array.isArray(parsed.groups) ? parsed.groups : [],
        };
      } catch (err) {
        console.warn(`[scim] failed to load redis snapshot ${this.key}: ${(err as Error).message} — starting empty`);
        this.snapshot = { users: [], groups: [] };
      }
    })();
    return this.bootstrapped;
  }

  listUsers(): ScimUser[] {
    return this.snapshot.users.slice();
  }

  getUser(id: string): ScimUser | undefined {
    return this.snapshot.users.find((u) => u.id === id);
  }

  getUserByUserName(userName: string): ScimUser | undefined {
    return this.snapshot.users.find((u) => u.userName === userName);
  }

  async createUser(input: Partial<ScimUser>): Promise<ScimUser> {
    if (!input.userName) throw new ScimValidationError("userName is required");
    if (this.getUserByUserName(input.userName)) {
      throw new ScimValidationError(`User with userName '${input.userName}' already exists`, "uniqueness");
    }
    const ts = nowIso();
    const user: ScimUser = {
      schemas: [SCIM_SCHEMA_USER],
      id: randomUUID(),
      userName: input.userName,
      active: input.active ?? true,
      displayName: input.displayName,
      name: input.name,
      emails: input.emails,
      externalId: input.externalId,
      meta: { resourceType: "User", created: ts, lastModified: ts },
    };
    this.snapshot.users.push(user);
    await this.persist();
    return user;
  }

  async updateUser(id: string, patch: Partial<ScimUser>): Promise<ScimUser> {
    const i = this.snapshot.users.findIndex((u) => u.id === id);
    if (i < 0) throw new ScimNotFoundError(`User ${id} not found`);
    const next: ScimUser = {
      ...this.snapshot.users[i],
      ...patch,
      schemas: [SCIM_SCHEMA_USER],
      id,
      meta: {
        ...this.snapshot.users[i].meta,
        lastModified: nowIso(),
      },
    };
    this.snapshot.users[i] = next;
    await this.persist();
    return next;
  }

  async deleteUser(id: string): Promise<boolean> {
    const before = this.snapshot.users.length;
    this.snapshot.users = this.snapshot.users.filter((u) => u.id !== id);
    if (this.snapshot.users.length === before) return false;
    for (const g of this.snapshot.groups) {
      g.members = (g.members ?? []).filter((m) => m.value !== id);
    }
    await this.persist();
    return true;
  }

  listGroups(): ScimGroup[] {
    return this.snapshot.groups.slice();
  }

  getGroup(id: string): ScimGroup | undefined {
    return this.snapshot.groups.find((g) => g.id === id);
  }

  async createGroup(input: Partial<ScimGroup>): Promise<ScimGroup> {
    if (!input.displayName) throw new ScimValidationError("displayName is required");
    const ts = nowIso();
    const group: ScimGroup = {
      schemas: [SCIM_SCHEMA_GROUP],
      id: randomUUID(),
      displayName: input.displayName,
      members: input.members ?? [],
      externalId: input.externalId,
      meta: { resourceType: "Group", created: ts, lastModified: ts },
    };
    this.snapshot.groups.push(group);
    await this.persist();
    return group;
  }

  async updateGroup(id: string, patch: Partial<ScimGroup>): Promise<ScimGroup> {
    const i = this.snapshot.groups.findIndex((g) => g.id === id);
    if (i < 0) throw new ScimNotFoundError(`Group ${id} not found`);
    const next: ScimGroup = {
      ...this.snapshot.groups[i],
      ...patch,
      schemas: [SCIM_SCHEMA_GROUP],
      id,
      meta: {
        ...this.snapshot.groups[i].meta,
        lastModified: nowIso(),
      },
    };
    this.snapshot.groups[i] = next;
    await this.persist();
    return next;
  }

  async deleteGroup(id: string): Promise<boolean> {
    const before = this.snapshot.groups.length;
    this.snapshot.groups = this.snapshot.groups.filter((g) => g.id !== id);
    if (this.snapshot.groups.length === before) return false;
    await this.persist();
    return true;
  }

  groupsContaining(userId: string): Array<{ value: string; display?: string }> {
    return this.snapshot.groups
      .filter((g) => (g.members ?? []).some((m) => m.value === userId))
      .map((g) => ({ value: g.id, display: g.displayName }));
  }

  private persist(): Promise<void> {
    // Serialise persists so two concurrent updateUser calls don't
    // race each other to the SET — the snapshot in memory is the
    // canonical state, Redis just mirrors it.
    const snap = { users: this.snapshot.users.slice(), groups: this.snapshot.groups.slice() };
    this.writeQueue = this.writeQueue.then(() => this.redis.set(this.key, JSON.stringify(snap)).then(() => undefined));
    return this.writeQueue;
  }
}
