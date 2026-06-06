// SCIM store — file-backed JSON for users + groups.
//
// F21a uses an on-disk JSON file (atomic tmp+rename, mode 0600).
// Multi-replica deployments should plug the F8 SessionStore in here
// — that's F21b. The interface intentionally mirrors what the
// SessionStore exposes so the swap is purely additive.

import { readFile, writeFile, mkdir, rename } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

import { nowIso, type ScimGroup, type ScimUser, SCIM_SCHEMA_GROUP, SCIM_SCHEMA_USER } from "./types.js";

export interface ScimSnapshot {
  users: ScimUser[];
  groups: ScimGroup[];
}

const EMPTY: ScimSnapshot = { users: [], groups: [] };

export class ScimStore {
  private readonly path: string;
  private snapshot: ScimSnapshot = EMPTY;
  private bootstrapped: Promise<void> | null = null;

  constructor(path: string) {
    this.path = path;
  }

  async load(): Promise<void> {
    if (this.bootstrapped) return this.bootstrapped;
    this.bootstrapped = (async () => {
      try {
        const raw = await readFile(this.path, "utf8");
        const parsed = JSON.parse(raw) as Partial<ScimSnapshot>;
        this.snapshot = {
          users: Array.isArray(parsed.users) ? parsed.users : [],
          groups: Array.isArray(parsed.groups) ? parsed.groups : [],
        };
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code === "ENOENT") {
          this.snapshot = { users: [], groups: [] };
          return;
        }
        console.warn(`[scim] failed to load ${this.path}: ${(err as Error).message} — starting empty`);
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
    // Also remove the user from every group's members list.
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

  /** Look up the groups a user is currently a member of — used to
   *  populate `User.groups` on read responses. */
  groupsContaining(userId: string): Array<{ value: string; display?: string }> {
    return this.snapshot.groups
      .filter((g) => (g.members ?? []).some((m) => m.value === userId))
      .map((g) => ({ value: g.id, display: g.displayName }));
  }

  private async persist(): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true }).catch(() => undefined);
    const tmp = `${this.path}.tmp`;
    await writeFile(tmp, JSON.stringify(this.snapshot, null, 2), { mode: 0o600 });
    await rename(tmp, this.path);
  }
}

export class ScimValidationError extends Error {
  constructor(message: string, public readonly scimType?: string) {
    super(message);
    this.name = "ScimValidationError";
  }
}

export class ScimNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScimNotFoundError";
  }
}
