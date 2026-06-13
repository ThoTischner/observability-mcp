import { test, expect } from "@playwright/test";

const BASE = process.env.OMCP_UI_BASE || "http://localhost:3000";

// The OSS demo has no entitlement token, so /api/info.governance.entitlements
// is all-false and every enterprise feature must read as "visible but locked":
// a 🔒 badge on the nav item and an explanatory banner on the page.
test.describe("Entitlement lock optic (OSS default — everything locked)", () => {
  test("nav-rail shows a lock badge on each entitled feature", async ({ page }) => {
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto(BASE, { waitUntil: "networkidle" });

    for (const pageId of ["products", "access", "policies", "audit"]) {
      const btn = page.locator(`.nav-btn[data-page="${pageId}"]`);
      await expect(btn).toHaveClass(/ent-locked/);
      await expect(btn.locator(".ent-lock")).toBeVisible();
    }
    await expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
  });

  test("each entitled page shows its Enterprise lock banner naming the feature", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    for (const [pageId, feature] of [
      ["access", "access-control"],
      ["products", "access-control"],
      ["policies", "access-control"],
      ["audit", "audit"],
    ]) {
      await page.locator(`.nav-btn[data-page="${pageId}"]`).click();
      const banner = page.locator(`#page-${pageId} .ent-banner[data-ent-feature="${feature}"]`);
      await expect(banner).toBeVisible();
      await expect(banner).toContainText(/Enterprise feature/i);
      await expect(banner.locator("code", { hasText: feature })).toBeVisible();
    }
  });

  test("Provisioning sub-tab carries a SCIM lock badge + banner", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.locator('.nav-btn[data-page="policies"]').click();
    const provTab = page.locator('.pol-subtab[data-pol-tab="provisioning"]');
    await expect(provTab.locator(".ent-lock")).toBeVisible();
    await provTab.click();
    const banner = page.locator('#pol-pane-provisioning .ent-banner[data-ent-feature="scim"]');
    await expect(banner).toBeVisible();
    await expect(banner).toContainText(/scim/i);
  });
});
