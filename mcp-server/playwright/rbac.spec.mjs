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

  test("Bindings + Subjects sub-tabs render placeholder copy (slice G/H land them)", async ({ page }) => {
    await page.goto(BASE);
    await page.click("[data-page=policies]");
    await page.waitForSelector("#page-policies.active");
    await page.click(".pol-subtab[data-pol-tab=bindings]");
    await expect(page.locator("#pol-pane-bindings")).toBeVisible();
    await expect(page.locator("#pol-pane-bindings")).toContainText(/Bindings are the who/i);
    await page.click(".pol-subtab[data-pol-tab=subjects]");
    await expect(page.locator("#pol-pane-subjects")).toBeVisible();
    await expect(page.locator("#pol-pane-subjects")).toContainText(/OMCP_USERS_FILE/);
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
