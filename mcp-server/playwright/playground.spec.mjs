import { test, expect } from "@playwright/test";

const BASE = process.env.OMCP_UI_BASE || "http://localhost:3000";

test.describe("Playground tab (Q13)", () => {
  test("opens via rail click, shows tool picker + JSON args + result panel", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(BASE, { waitUntil: "networkidle" });

    // Click the Playground rail item.
    await page.locator('.nav-btn[data-page="playground"]').click();
    await expect(page.locator('#page-playground')).toHaveClass(/active/);

    // The picker populates from /api/tools/registry — at least the
    // placeholder + one real tool should be present after init runs.
    const sel = page.locator('#pg-tool');
    await expect(sel).toBeVisible();
    await expect(sel).toContainText("select a tool", { ignoreCase: true });
    // Wait for at least one option beyond the placeholder to appear.
    await expect.poll(async () => sel.locator('option').count()).toBeGreaterThan(1);

    // The JSON args textarea defaults to `{}`.
    const args = page.locator('#pg-args');
    await expect(args).toHaveValue("{}");

    // The Invoke button is wired.
    await expect(page.locator('#pg-run-btn')).toBeEnabled();

    // The result panel starts hidden.
    await expect(page.locator('#pg-result-card')).toBeHidden();
  });

  test("invalid JSON args surface a client-side error without hitting the server", async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.locator('.nav-btn[data-page="playground"]').click();

    // Wait for tool list to load, then pick the first real tool
    const sel = page.locator('#pg-tool');
    await expect.poll(async () => sel.locator('option').count()).toBeGreaterThan(1);
    const firstReal = await sel.locator('option:not([value=""])').first().getAttribute('value');
    await sel.selectOption(firstReal);

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
