import { test, expect } from "@playwright/test";

const BASE = process.env.OMCP_UI_BASE || "http://localhost:3000";

// Interaction coverage for the Add-Source modal — the v3.2 audit flagged
// "add source + test-connection" as having no playwright coverage. Exercises
// the two real interactions with stable selectors:
//   - Test Connection (#test-btn → testConnection() → #test-result.show)
//   - inline URL validation (#save-btn with a bad URL → #src-url-err shown)
// Guards skip gracefully if the Add-Source affordance isn't exposed (e.g. the
// build hides sources:write controls), so this never false-fails.

async function openAddSource(page) {
  await page.goto(BASE, { waitUntil: "networkidle" });
  const addBtn = page.locator('button:has-text("Add Source")').first();
  if ((await addBtn.count()) === 0 || !(await addBtn.isVisible())) {
    return false;
  }
  await addBtn.click();
  await expect(page.locator("#source-modal")).toBeVisible({ timeout: 5_000 });
  return true;
}

test.describe("Sources — Add-Source modal interactions", () => {
  test("Test Connection renders a result over the wire (#test-result)", async ({ page }) => {
    if (!(await openAddSource(page))) test.skip(true, "Add Source affordance not exposed");

    await page.locator("#src-name").fill("e2e-probe");
    // Type select — pick prometheus if present (first real option otherwise).
    const typeSel = page.locator("#src-type");
    if ((await typeSel.count()) > 0) {
      await typeSel.selectOption("prometheus").catch(() => {});
    }
    // A syntactically valid but unreachable URL: the test must render a
    // result (success OR failure) — we assert the flow runs end-to-end, not
    // that the probe succeeds.
    await page.locator("#src-url").fill("http://127.0.0.1:1");

    await page.locator("#test-btn").click();

    // testConnection() adds the `show` class once the /api probe returns.
    await expect(page.locator("#test-result")).toHaveClass(/show/, { timeout: 15_000 });
    await expect(page.locator("#test-result")).toBeVisible();
  });

  test("invalid URL is rejected inline on save (#src-url-err)", async ({ page }) => {
    if (!(await openAddSource(page))) test.skip(true, "Add Source affordance not exposed");

    await page.locator("#src-name").fill("e2e-badurl");
    await page.locator("#src-url").fill("notaurl");
    await page.locator("#save-btn").click();

    // Save must NOT close the modal on an invalid URL; the field error shows.
    await expect(page.locator("#source-modal")).toBeVisible();
    await expect(page.locator("#src-url-err")).toBeVisible({ timeout: 5_000 });
  });
});
