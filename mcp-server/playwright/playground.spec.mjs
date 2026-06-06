import { test, expect } from "@playwright/test";

const BASE = process.env.OMCP_UI_BASE || "http://localhost:3000";

test.describe("Playground tab (Q13)", () => {
  test("opens via rail click, shows tool picker + JSON args + result panel", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(BASE, { waitUntil: "networkidle" });

    // Click the Playground rail item.
    await page.locator('.nav-btn[data-page="playground"]').click();
    await expect(page.locator('#page-playground')).toHaveClass(/active/);

    // The tool picker is a combobox, CLOSED at rest — no menu visible.
    const combo = page.locator('#pg-combo-input');
    await expect(combo).toBeVisible();
    await expect(page.locator('#pg-combo-menu')).toBeHidden();

    // Invoke is disabled until a tool is picked.
    await expect(page.locator('#pg-run-btn')).toBeDisabled();

    // Focusing the field opens the menu with grouped options.
    await combo.click();
    await expect(page.locator('#pg-combo-menu')).toBeVisible();
    await expect.poll(async () => page.locator('#pg-combo-menu .pg-opt').count()).toBeGreaterThan(0);
    await expect(page.locator('#pg-combo-menu .pg-grp-hdr').first()).toBeVisible();

    // Picking an option fills the field, shows the summary, enables Invoke,
    // and closes the menu.
    await page.locator('#pg-combo-menu .pg-opt').first().click();
    await expect(page.locator('#pg-combo-menu')).toBeHidden();
    await expect(combo).not.toHaveValue("");
    await expect(page.locator('#pg-run-btn')).toBeEnabled();

    // The JSON args textarea defaults to `{}`.
    await expect(page.locator('#pg-args')).toHaveValue("{}");

    // The result panel starts hidden.
    await expect(page.locator('#pg-result-card')).toBeHidden();
  });

  test("combobox type-ahead filters the option list", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.locator('.nav-btn[data-page="playground"]').click();
    const combo = page.locator('#pg-combo-input');
    await combo.click();
    await expect(page.locator('#pg-combo-menu')).toBeVisible();
    const total = await page.locator('#pg-combo-menu .pg-opt').count();
    // Type a fragment that only some tools match.
    await combo.fill("list");
    await expect.poll(async () => page.locator('#pg-combo-menu .pg-opt').count()).toBeLessThan(total);
    // Every visible option name contains the query.
    const names = await page.locator('#pg-combo-menu .pg-opt .nm').allTextContents();
    for (const n of names) expect(n.toLowerCase()).toContain("list");
  });

  test("invalid JSON args surface a client-side error without hitting the server", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.locator('.nav-btn[data-page="playground"]').click();

    // Open the combobox and pick the first option.
    const combo = page.locator('#pg-combo-input');
    await combo.click();
    await expect.poll(async () => page.locator('#pg-combo-menu .pg-opt').count()).toBeGreaterThan(0);
    await page.locator('#pg-combo-menu .pg-opt').first().click();

    // Type broken JSON into the args box
    await page.locator('#pg-args').fill('{ not valid json');

    // Capture any fetch to /api/playground/invoke — we expect NONE
    let invokeCalled = false;
    page.on('request', (req) => {
      if (req.url().includes('/api/playground/invoke')) invokeCalled = true;
    });

    await page.locator('#pg-run-btn').click();
    // Result card becomes visible with the client-side parse error.
    await expect(page.locator('#pg-result-card')).toBeVisible();
    await expect(page.locator('#pg-result-body')).toContainText("not valid JSON");
    // Give the network a chance to settle then assert no invoke fired.
    await page.waitForTimeout(150);
    expect(invokeCalled).toBe(false);
  });
});
