import { test, expect } from "@playwright/test";

const BASE = process.env.OMCP_UI_BASE || "http://localhost:3000";

async function gotoApp(page) {
  await page.goto(BASE, { waitUntil: "networkidle" });
}

test.describe("Density toggle", () => {
  test("density toggle flips data-density on <html> and persists to localStorage", async ({ page }) => {
    await gotoApp(page);
    const initial = await page.locator("html").getAttribute("data-density");
    expect(["comfortable", "compact"]).toContain(initial);

    const btn = page.locator("#density-toggle");
    await expect(btn).toBeVisible();

    await btn.click();
    const next = await page.locator("html").getAttribute("data-density");
    expect(next).not.toBe(initial);

    // Persisted in localStorage
    const stored = await page.evaluate(() => localStorage.getItem("omcp-density"));
    expect(stored).toBe(next);

    // Reload — density survives
    await page.reload({ waitUntil: "networkidle" });
    const afterReload = await page.locator("html").getAttribute("data-density");
    expect(afterReload).toBe(next);
  });
});

test.describe("Sources filter + sort", () => {
  test("filter input narrows the visible row count", async ({ page }) => {
    await gotoApp(page);
    await page.locator('[data-page="sources"]').click();
    // Wait for the sources panel to render at least one row + filter.
    const filter = page.locator("#src-filter");
    await expect(filter).toBeVisible({ timeout: 10_000 });

    // Initial count text like "N of N"
    const countText = await page.locator(".list-filter .count").first().innerText();
    const m = countText.match(/(\d+)\s+of\s+(\d+)/i);
    expect(m).not.toBeNull();
    const total = parseInt(m[2], 10);
    expect(total).toBeGreaterThan(0);

    // Typing a clearly non-matching string drives count to 0
    await filter.fill("zzz-no-such-source-xyz");
    await expect(page.locator(".list-filter .count").first()).toContainText(`0 of ${total}`);

    // Clearing restores the original count
    await filter.fill("");
    await expect(page.locator(".list-filter .count").first()).toContainText(`${total} of ${total}`);
  });

  test("sortable header toggles sort indicator class on click", async ({ page }) => {
    await gotoApp(page);
    await page.locator('[data-page="sources"]').click();

    // Switch to Table view so sortable headers are present.
    // Scope to #src-views so the Products page's view-toggle
    // (which also has a "Table" button) doesn't trip strict-mode.
    const tableBtn = page.locator("#src-view-table");
    if (await tableBtn.count()) await tableBtn.click();

    const nameHeader = page.locator('th.sortable[data-sort-key="name"]');
    await expect(nameHeader).toBeVisible({ timeout: 5_000 });

    // First state: name is the default sort, expect sort-asc.
    await expect(nameHeader).toHaveClass(/sort-asc/);

    // Click → desc.
    await nameHeader.click();
    await expect(nameHeader).toHaveClass(/sort-desc/);

    // Click another column → that one becomes asc, name loses the class.
    const typeHeader = page.locator('th.sortable[data-sort-key="type"]');
    await typeHeader.click();
    await expect(typeHeader).toHaveClass(/sort-asc/);
    await expect(nameHeader).not.toHaveClass(/sort-asc|sort-desc/);

    // Persisted: reload + return to Sources Table view + Type header should still be asc.
    await page.reload({ waitUntil: "networkidle" });
    await page.locator('[data-page="sources"]').click();
    const tableBtn2 = page.locator(".view-toggle button", { hasText: "Table" });
    if (await tableBtn2.count()) await tableBtn2.click();
    await expect(page.locator('th.sortable[data-sort-key="type"]')).toHaveClass(/sort-asc/, { timeout: 5_000 });
  });
});
