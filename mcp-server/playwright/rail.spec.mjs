import { test, expect } from "@playwright/test";

const BASE = process.env.OMCP_UI_BASE || "http://localhost:3000";

test.describe("Side rail collapse", () => {
  test("collapse toggle flips data-rail and shrinks the rail", async ({ page }) => {
    // Force a wide viewport so the auto-collapse-on-narrow heuristic
    // doesn't change the starting state out from under the test.
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(BASE, { waitUntil: "networkidle" });

    const initial = await page.locator("html").getAttribute("data-rail");
    expect(initial).toBe("expanded");

    const rail = page.locator(".siderail");
    const wideBox = await rail.boundingBox();
    expect(wideBox?.width).toBeGreaterThan(180);

    await page.locator("#rail-collapse-btn").click();
    await expect(page.locator("html")).toHaveAttribute("data-rail", "collapsed");

    const narrowBox = await rail.boundingBox();
    expect(narrowBox?.width).toBeLessThan(100);

    // Brand title hidden when collapsed
    await expect(page.locator(".siderail .rail-title")).toBeHidden();
    // Nav icons still visible
    await expect(page.locator('.siderail [data-page="dashboard"] .nav-ico')).toBeVisible();

    // Persisted to localStorage
    expect(await page.evaluate(() => localStorage.getItem("omcp-rail"))).toBe("collapsed");

    // Survives reload
    await page.reload({ waitUntil: "networkidle" });
    await expect(page.locator("html")).toHaveAttribute("data-rail", "collapsed");

    // Expand again
    await page.locator("#rail-collapse-btn").click();
    await expect(page.locator("html")).toHaveAttribute("data-rail", "expanded");
    expect(await page.evaluate(() => localStorage.getItem("omcp-rail"))).toBe("expanded");
  });

  test("nav-btn title attributes are present so collapsed-mode tooltips work", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    // Every primary nav button needs a title for browser tooltip discoverability.
    const buttons = await page.locator('.siderail .nav-btn[data-page]').all();
    expect(buttons.length).toBeGreaterThanOrEqual(5);
    for (const b of buttons) {
      const title = await b.getAttribute("title");
      expect(title, "nav button missing title").not.toBeNull();
      expect(title.length).toBeGreaterThan(0);
    }
  });
});
