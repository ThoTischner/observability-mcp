import { test, expect } from "@playwright/test";

const BASE = process.env.OMCP_UI_BASE || "http://localhost:3000";

test.describe("Topology graph affordances", () => {
  test("Graph tab exposes zoom toolbar and keyboard hint", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.locator('[data-page="topology"]').click();

    // Switch to the Graph sub-tab (renderTopologyGraph is lazy).
    const graphBtn = page.locator(".tab-btn", { hasText: "Graph" });
    await graphBtn.click();

    // Zoom toolbar visible with all three buttons.
    const toolbar = page.locator("#topology-graph-host .topo-controls");
    await expect(toolbar).toBeVisible({ timeout: 10_000 });
    await expect(toolbar.locator("button", { hasText: "+" })).toBeVisible();
    await expect(toolbar.locator("button", { hasText: "−" })).toBeVisible();
    await expect(toolbar.locator('[aria-label="Reset view"]')).toBeVisible();

    // Keyboard-hint badge visible (a11y discoverability).
    await expect(page.locator("#topo-hint")).toBeVisible();

    // SVG shell has the expected a11y attributes.
    const svg = page.locator("#topology-graph-svg");
    await expect(svg).toHaveAttribute("role", "application");
    await expect(svg).toHaveAttribute("tabindex", "0");
  });

  test("Reset view button restores the world transform", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.locator('[data-page="topology"]').click();
    await page.locator(".tab-btn", { hasText: "Graph" }).click();

    // If the graph drew any nodes, the topo-g world group exists. Zoom in,
    // then reset — transform should return to scale 1 / translate 0.
    const topoG = page.locator("#topo-g");
    if ((await topoG.count()) === 0) test.skip(true, "no topology data in this run");

    await page.locator('#topology-graph-host .topo-controls button[aria-label="Zoom in"]').click();
    await page.locator('#topology-graph-host .topo-controls button[aria-label="Zoom in"]').click();
    const zoomed = await topoG.getAttribute("transform");
    expect(zoomed).toMatch(/scale\([^)]+\)/);

    await page.locator('#topology-graph-host .topo-controls button[aria-label="Reset view"]').click();
    const reset = await topoG.getAttribute("transform");
    // After reset: translate(0 0) scale(1)
    expect(reset).toContain("scale(1)");
    expect(reset).toContain("translate(0 0)");
  });
});
