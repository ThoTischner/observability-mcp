import { test, expect } from "@playwright/test";

const BASE = process.env.OMCP_UI_BASE || "http://localhost:3000";

test.describe("Governance IA — overview + clarifying subtitles", () => {
  test("Access Control shows the governance overview flow", async ({ page }) => {
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.locator('[data-page="access"]').click();
    await expect(page.locator("#page-access")).toHaveClass(/active/);

    const overview = page.locator("#page-access .gov-overview");
    await expect(overview).toBeVisible();
    // The four layered steps in order.
    for (const step of ["Access Control", "Products", "Policies", "Inspect"]) {
      await expect(overview.locator(".gov-step b", { hasText: step })).toBeVisible();
    }
    await expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
  });

  test("each governance tab carries a clarifying subtitle", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    for (const [pageId, needle] of [
      ["access", /Authentication/i],
      ["policies", /allowed/i],
      ["inspect", /normal/i],
      ["audit", /tamper-evident/i],
    ]) {
      await page.locator(`[data-page="${pageId}"]`).click();
      await expect(page.locator(`#page-${pageId} .gov-sub`).first()).toContainText(needle);
    }
  });
});
