// Read-only projection of the SCIM store for the dashboard's Provisioning
// sub-tab (/api/provisioning). Pure + secret-free: only the fields the UI
// table renders, never the SCIM bearer token or anything sensitive. Kept
// separate from the route handler so it's unit-testable without booting the app.

import type { IScimStore } from "./store.js";

export interface ProvisioningUserView {
  userName: string;
  displayName: string;
  active: boolean;
  groups: string[];
  externalId?: string;
}

export interface ProvisioningGroupView {
  displayName: string;
  members: number;
  externalId?: string;
}

export interface ProvisioningView {
  configured: boolean;
  users: ProvisioningUserView[];
  groups: ProvisioningGroupView[];
  note?: string;
}

const NOT_CONFIGURED_NOTE =
  "SCIM provisioning is not enabled. Set OMCP_SCIM_TOKEN (and OMCP_SCIM_BACKEND/store) " +
  "to let an identity provider push Users/Groups — this view then mirrors that directory.";

/** Project the SCIM store into the compact, secret-free shape the UI renders.
 *  A null store (SCIM not enabled) yields configured:false + an explanatory
 *  note, NOT an error — the dashboard shows "how to enable" instead of a 404. */
export function projectProvisioning(store: IScimStore | null): ProvisioningView {
  if (!store) {
    return { configured: false, users: [], groups: [], note: NOT_CONFIGURED_NOTE };
  }
  const users: ProvisioningUserView[] = store.listUsers().map((u) => ({
    userName: u.userName,
    displayName: u.displayName || u.name?.formatted || "",
    active: u.active !== false,
    groups: (u.groups || []).map((g) => g.display || g.value),
    externalId: u.externalId,
  }));
  const groups: ProvisioningGroupView[] = store.listGroups().map((g) => ({
    displayName: g.displayName,
    members: (g.members || []).length,
    externalId: g.externalId,
  }));
  return { configured: true, users, groups };
}
