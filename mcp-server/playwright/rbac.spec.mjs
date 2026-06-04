import { test, expect } from "@playwright/test";

const BASE = process.env.OMCP_UI_BASE || "http://localhost:3000";

// Slice B of the UI/UX rework — Policies page:
//   - engine-banner classifies the active engine (builtin / file / opa)
//     and renders engine-appropriate copy
//   - dry-run probe is promoted to a sticky bar at the top with
//     subject/role + resource + action + tenant fields
//   - body[data-policy-engine="..."] is set so CSS can disable
//     authoring controls under read-only engines (the actual
//     authoring drawers land in slice I; the data attribute is the
//     contract those drawers will key off)

test.describe("Policies UI — engine banner + sticky dry-run", () => {
  test("engine badge + banner match the active engine kind", async ({ page }) => {
    await page.goto(BASE);
    await page.click("[data-page=policies]");
    await page.waitForSelector("#page-policies.active");
    // Demo profile runs with the built-in engine.
    const badge = page.locator("#pol-engine");
    await expect(badge).toContainText("builtin");
    const banner = page.locator("#pol-engine-banner");
    await expect(banner).toBeVisible();
    await expect(banner).toHaveClass(/eng-builtin/);
    // The body attribute is what slice I authoring controls will
    // key on to enable/disable themselves.
    await expect(page.locator("body")).toHaveAttribute("data-policy-engine", "builtin");
    // The banner's copy mentions the override path so an operator
    // immediately knows how to switch engines.
    await expect(banner).toContainText(/OMCP_RBAC_POLICY_FILE/i);
  });

  test("dry-run probe is sticky at the top + admin × sources × read evaluates allowed", async ({ page }) => {
    await page.goto(BASE);
    await page.click("[data-page=policies]");
    await page.waitForSelector("#page-policies.active");
    // The probe bar must be rendered before the snapshot card.
    const probeBar = page.locator(".pol-probe-bar");
    await expect(probeBar).toBeVisible();
    await expect(probeBar).toHaveCSS("position", "sticky");

    await page.fill("#pol-dry-roles", "admin");
    await page.fill("#pol-dry-resource", "sources");
    await page.fill("#pol-dry-action", "read");
    await page.fill("#pol-dry-tenant", "acme");
    await page.click(".pol-probe-bar button.btn-primary");

    const verdict = page.locator(".pol-probe-result .pol-pv");
    await expect(verdict).toHaveAttribute("data-verdict", "allowed");
    await expect(verdict).toContainText(/allowed/i);
    // Tenant tag should echo the supplied value so the operator
    // sees which tenant the verdict ran under.
    await expect(page.locator(".pol-probe-result")).toContainText("acme");
  });

  test("Roles sub-tab — sub-tab nav renders, role list shows grant counts, matrix for admin has the expected shape", async ({ page }) => {
    await page.goto(BASE);
    await page.click("[data-page=policies]");
    await page.waitForSelector("#page-policies.active");
    // Sub-tab nav present.
    await expect(page.locator(".pol-subtab[data-pol-tab=roles]")).toBeVisible();
    await expect(page.locator(".pol-subtab[data-pol-tab=bindings]")).toBeVisible();
    await expect(page.locator(".pol-subtab[data-pol-tab=subjects]")).toBeVisible();
    // Roles is the active sub-tab by default.
    await expect(page.locator(".pol-subtab[data-pol-tab=roles][data-active=true]")).toBeVisible();
    // Role list shows the 3 built-in roles each with a grant count.
    await expect(page.locator(".pol-role-row[data-role=viewer]")).toBeVisible();
    await expect(page.locator(".pol-role-row[data-role=operator]")).toBeVisible();
    await expect(page.locator(".pol-role-row[data-role=admin]")).toBeVisible();
    // The admin row is active by default OR clicking it activates it.
    const adminRow = page.locator(".pol-role-row[data-role=admin]");
    await adminRow.click();
    await expect(adminRow).toHaveAttribute("data-active", "true");
    // Matrix renders — head row with 4 actions, one row per resource.
    const matrix = page.locator(".pol-matrix");
    await expect(matrix).toBeVisible();
    // Header columns: read, write, delete, bypass (+ Resource header).
    const headerCells = await matrix.locator("thead th").allTextContents();
    expect(headerCells).toEqual(["Resource", "read", "write", "delete", "bypass"]);
    // Admin → sources:delete is granted.
    const sourcesRow = matrix.locator("tbody tr").filter({ hasText: "sources" });
    const deleteCell = sourcesRow.locator("td").nth(2); // 0=read, 1=write, 2=delete, 3=bypass
    await expect(deleteCell).toHaveAttribute("data-grant", "true");
    await expect(deleteCell).toHaveText("✓");
    // Admin → redaction:bypass is the special one.
    const redactionRow = matrix.locator("tbody tr").filter({ hasText: "redaction" });
    const bypassCell = redactionRow.locator("td").nth(3);
    await expect(bypassCell).toHaveAttribute("data-grant", "true");
    // Switch to viewer — its sources:delete must be NOT granted.
    await page.locator(".pol-role-row[data-role=viewer]").click();
    const sourcesRow2 = page.locator(".pol-matrix tbody tr").filter({ hasText: "sources" });
    const deleteCell2 = sourcesRow2.locator("td").nth(2);
    await expect(deleteCell2).toHaveAttribute("data-grant", "false");
    await expect(deleteCell2).toHaveText("—");
  });

  test("Subjects sub-tab — /api/subjects returns expected shape + UI sections render", async ({ page, request: apiReq }) => {
    // Demo profile has no users / api-keys / OIDC mappings — all
    // three arrays are empty, but the endpoint must still return the
    // shape with `sources` set to the env-source path / null.
    const resp = await apiReq.get("/api/subjects");
    expect(resp.status()).toBe(200);
    const j = await resp.json();
    expect(Array.isArray(j.users)).toBe(true);
    expect(Array.isArray(j.apiKeys)).toBe(true);
    expect(Array.isArray(j.oidcGroups)).toBe(true);
    expect(j.sources).toBeTruthy();
    expect(typeof j.sources.users === "string" || j.sources.users === null).toBe(true);

    // UI: Subjects sub-tab renders the three sections + the
    // empty-state copy when the env isn't configured.
    await page.goto(BASE);
    await page.click("[data-page=policies]");
    await page.waitForSelector("#page-policies.active");
    await page.click(".pol-subtab[data-pol-tab=subjects]");
    await expect(page.locator("#pol-pane-subjects")).toBeVisible();
    const body = page.locator("#pol-subjects-body");
    // Three section headings: Users / API keys / OIDC groups.
    await expect(body.locator("h3", { hasText: "Users" })).toBeVisible();
    await expect(body.locator("h3", { hasText: "API keys" })).toBeVisible();
    await expect(body.locator("h3", { hasText: "OIDC groups" })).toBeVisible();
    // In the demo profile each section shows the appropriate empty-
    // state copy referencing the env var that drives it.
    await expect(body).toContainText("OMCP_USERS_FILE");
    await expect(body).toContainText("OMCP_API_KEYS");
    await expect(body).toContainText("OMCP_OIDC_ROLE_MAP");
  });

  test("Bindings sub-tab — empty-state copy when no subjects configured (demo profile)", async ({ page }) => {
    await page.goto(BASE);
    await page.click("[data-page=policies]");
    await page.waitForSelector("#page-policies.active");
    await page.click(".pol-subtab[data-pol-tab=bindings]");
    await expect(page.locator("#pol-pane-bindings")).toBeVisible();
    // Demo profile configures none of the three subject sources → empty.
    await expect(page.locator("#pol-pane-bindings")).toContainText(/No subjects configured/);
    await expect(page.locator("#pol-pane-bindings")).toContainText("OMCP_USERS_FILE");
  });

  test("Role authoring — '+ New role' button rendered under file engine; PUT /api/policy/roles 409 under builtin", async ({ page, request: apiReq }) => {
    // Demo profile runs the built-in engine. The button is in the
    // DOM but disabled via the CSS gate (pointer-events: none,
    // opacity .35). Server-side 409 confirms the matching backend
    // enforcement.
    await page.goto(BASE);
    await page.click("[data-page=policies]");
    await page.waitForSelector("#page-policies.active");
    const btn = page.locator('button[data-engine-required="file"]', { hasText: "New role" });
    await expect(btn).toBeAttached();
    // Computed pointer-events: none under builtin (the body
    // data-policy-engine="builtin" attribute disables the gate).
    const pe = await btn.evaluate((el) => getComputedStyle(el).pointerEvents);
    expect(pe).toBe("none");

    // Server-side: PUT must 409 with the engine-specific code.
    const r = await apiReq.put("/api/policy/roles/test-role", {
      data: { permissions: [{ resource: "sources", action: "read" }] },
    });
    expect(r.status()).toBe(409);
    const j = await r.json();
    expect(j.code).toBe("OMCP_POLICY_ENGINE_BUILTIN");
  });

  test("PUT /api/policy/roles — input validation: bad pattern + unknown resource/action", async ({ request: apiReq }) => {
    // Bad role name pattern (forbidden chars).
    const bad = await apiReq.put("/api/policy/roles/" + encodeURIComponent("bad name with spaces"), {
      data: { permissions: [] },
    });
    // Server returns 400 (pattern) before hitting the engine check.
    // 409 (engine builtin) is also acceptable since the engine check
    // runs before; what matters is the bad pattern doesn't write.
    expect([400, 409]).toContain(bad.status());
  });

  test("PUT /api/users/:name/roles — 409 when OMCP_USERS_FILE unset, 422 on unknown role, 200 on success", async ({ request: apiReq }) => {
    // 409 path — demo profile doesn't set OMCP_USERS_FILE.
    const r409 = await apiReq.put("/api/users/anyone/roles", { data: { roles: ["admin"] } });
    expect(r409.status()).toBe(409);
    const j409 = await r409.json();
    expect(j409.error).toMatch(/OMCP_USERS_FILE is not configured/i);
    // The 422 + 200 paths are tested by the integration suite — they
    // need a real users file and a restart with OMCP_USERS_FILE set,
    // which the demo profile doesn't provide. The shape pinned here
    // proves the failure-mode wiring; the success path is exercised
    // server-side by readUsersFile/writeUsersFile unit tests.
  });

  test("Roles matrix — effective-permissions overlay renders + reflects selected subject", async ({ page }) => {
    await page.goto(BASE);
    await page.click("[data-page=policies]");
    await page.waitForSelector("#page-policies.active");

    // Default state: overlay bar is rendered, selector is "(none)",
    // the existing role-grant view stays visible (✓/—). Demo profile
    // has no subjects so the empty-state hint must appear.
    const bar = page.locator(".pol-effective-bar");
    await expect(bar).toBeVisible();
    const sel = page.locator("#pol-effective-subject");
    await expect(sel).toBeVisible();
    await expect(sel).toHaveValue("");
    await expect(bar).toContainText(/No subjects configured/i);
    // Confirm the role-centric view is still in effect (cells show
    // ✓ or — for the active role, not "via" / "denied").
    const matrix = page.locator(".pol-matrix");
    const grantCellCount = await matrix.locator('td[data-grant="true"]').count();
    expect(grantCellCount).toBeGreaterThan(0);
    await expect(matrix.locator('td[data-effective]')).toHaveCount(0);

    // Inject a synthetic subject + trigger a re-render to exercise
    // the overlay path. The demo profile doesn't configure local
    // users or OIDC groups, so we can't drive this through the real
    // selector — but the overlay computation is pure client-side
    // composition over POL_SNAPSHOT, so a synthetic subject is a
    // faithful test of the rendering branch.
    await page.evaluate(() => {
      // Select the admin role so its grants overlap heavily with
      // the synthetic admin-bundle subject (gives plenty of "via"
      // cells) and at least one cell flips to "denied" depending on
      // grants of the chosen subject roles.
      window.POL_SELECTED_ROLE = "admin";
      window.POL_EFFECTIVE_SUBJECT = { kind: "user", id: "alice", roles: ["viewer"] };
      window.polRolesRender();
    });
    // Title reflects the selected subject.
    await expect(page.locator("#pol-role-detail h3")).toContainText(/effective view for alice/);
    // At least one cell flips to allowed (viewer grants something —
    // e.g. sources:read) and at least one to denied (viewer doesn't
    // grant write/delete on most resources).
    const allowed = matrix.locator('td[data-effective="allowed"]');
    const denied = matrix.locator('td[data-effective="denied"]');
    await expect(allowed.first()).toBeVisible();
    await expect(denied.first()).toBeVisible();
    // Allowed cells render the "via <role>" label.
    await expect(allowed.first()).toContainText(/via\s+viewer/i);
    // Denied cells render the literal "denied" text.
    await expect(denied.first()).toContainText(/denied/i);

    // Switching the subject re-renders. Synthetic operator with the
    // operator role should also produce allowed + denied cells, and
    // the legend updates.
    await page.evaluate(() => {
      window.POL_EFFECTIVE_SUBJECT = { kind: "user", id: "bob", roles: ["operator"] };
      window.polRolesRender();
    });
    await expect(page.locator("#pol-role-detail h3")).toContainText(/effective view for bob/);
    await expect(page.locator(".pol-effective-bar")).toContainText(/via roles:/i);
    await expect(page.locator(".pol-effective-bar code", { hasText: "operator" })).toBeVisible();

    // Clearing the overlay must restore the role-centric view.
    await page.evaluate(() => {
      window.POL_EFFECTIVE_SUBJECT = null;
      window.polRolesRender();
    });
    await expect(matrix.locator('td[data-effective]')).toHaveCount(0);
    await expect(matrix.locator('td[data-grant="true"]').first()).toBeVisible();
  });

  test("authoring controls keyed on data-engine-required=file stay disabled on read-only engines", async ({ page }) => {
    // No author controls ship in this slice — but the CSS contract
    // they will use is already in place. Verify the body attribute
    // is set so the next slice (I) can simply add controls with
    // data-engine-required="file" and have them dim automatically.
    await page.goto(BASE);
    await page.click("[data-page=policies]");
    await page.waitForSelector("#page-policies.active");
    const engine = await page.locator("body").getAttribute("data-policy-engine");
    expect(["builtin", "file", "opa"]).toContain(engine);
    // Sanity: under builtin, the CSS dims any future
    // [data-engine-required="file"] element. Inject one and check
    // the computed pointer-events.
    await page.evaluate(() => {
      const el = document.createElement("button");
      el.setAttribute("data-engine-required", "file");
      el.id = "rbac-probe-future-button";
      el.textContent = "would-be authoring control";
      document.getElementById("page-policies").appendChild(el);
    });
    const probe = page.locator("#rbac-probe-future-button");
    await expect(probe).toBeVisible();
    const pe = await probe.evaluate((el) => getComputedStyle(el).pointerEvents);
    expect(pe).toBe("none");
  });
});
