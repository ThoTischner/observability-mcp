import { test, expect } from "@playwright/test";

const BASE = process.env.OMCP_UI_BASE || "http://localhost:3000";

test.describe("Inspect — Flows live graph", () => {
  test("Inspect tab renders the flow graph shell with no console errors", async ({ page }) => {
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.locator('[data-page="inspect"]').click();

    // Page is active.
    await expect(page.locator("#page-inspect")).toHaveClass(/active/);

    // Mode chip resolves to a real mode (observe by default in the demo).
    const chip = page.locator("#inspect-mode-chip");
    await expect(chip).toBeVisible();
    await expect(chip).toHaveText(/Off|Observe|Dry-run|Enforce/, { timeout: 10_000 });

    // Graph SVG shell + a11y attributes.
    const svg = page.locator("#inspect-graph-svg");
    await expect(svg).toBeVisible();
    await expect(svg).toHaveAttribute("role", "application");
    await expect(svg).toHaveAttribute("tabindex", "0");

    // Zoom toolbar with all three controls.
    const toolbar = page.locator("#page-inspect .topo-controls");
    await expect(toolbar.locator("button", { hasText: "+" })).toBeVisible();
    await expect(toolbar.locator("button", { hasText: "−" })).toBeVisible();
    await expect(toolbar.locator('[aria-label="Reset view"]')).toBeVisible();

    // Either the graph drew nodes (demo agent traffic) or the honest empty
    // state is shown — never a broken blank panel.
    await page.waitForTimeout(500);
    const nodes = await page.locator("#inspect-graph-svg .inode-g").count();
    const emptyVisible = await page.locator("#inspect-graph-empty").isVisible();
    expect(nodes > 0 || emptyVisible).toBeTruthy();

    expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
  });

  test("clicking a node drills into the real calls behind it", async ({ page }) => {
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.locator('[data-page="inspect"]').click();
    await page.waitForTimeout(800);
    const node = page.locator("#inspect-graph-svg .inode-g").first();
    if ((await node.count()) === 0) test.skip(true, "no flow traffic in this run");
    await node.click();
    // The drill panel resolves to a recent-calls list or an honest empty note.
    const drill = page.locator("#inspect-drill");
    await expect(drill).toBeVisible();
    await expect(drill).toContainText(/Recent calls|No calls|Unavailable/, { timeout: 10_000 });
    expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
  });

  test("Reset view restores the world transform", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.locator('[data-page="inspect"]').click();

    const root = page.locator("#inspect-root");
    if ((await root.count()) === 0) test.skip(true, "no inspect traffic in this run");

    await page.locator('#page-inspect .topo-controls button[aria-label="Zoom in"]').click();
    await page.locator('#page-inspect .topo-controls button[aria-label="Zoom in"]').click();
    expect(await root.getAttribute("transform")).toMatch(/scale\([^)]+\)/);

    await page.locator('#page-inspect .topo-controls button[aria-label="Reset view"]').click();
    expect(await root.getAttribute("transform")).toContain("scale(1)");
  });

  test("Live toggle flips the button label and pauses the svg", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.locator('[data-page="inspect"]').click();
    const btn = page.locator("#inspect-live-btn");
    await expect(btn).toHaveText(/Live/);
    await btn.click();
    await expect(btn).toHaveText(/Paused/);
    await expect(page.locator("#inspect-graph-svg")).toHaveClass(/paused/);
  });

  test("Profile tab learns from traffic and renders the review queue", async ({ page }) => {
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.locator('[data-page="inspect"]').click();
    await page.locator('#page-inspect .tab-btn', { hasText: "Profile" }).click();
    await expect(page.locator("#inspect-tab-profile")).toHaveClass(/active/);

    // Learn from the observed window.
    await page.locator('#inspect-tab-profile button', { hasText: "Learn from traffic" }).click();
    await page.waitForTimeout(800);

    // The review queue resolves to either suggestion cards (demo agent traffic)
    // or an honest empty state — never a broken panel. If suggestions appear,
    // accepting one moves it into the accepted-rules table.
    const queue = page.locator("#inspect-review-queue");
    await expect(queue).toBeVisible();
    const accept = page.locator('#inspect-review-queue button', { hasText: "Accept" }).first();
    if (await accept.count()) {
      await accept.click();
      await page.waitForTimeout(500);
      await expect(page.locator("#inspect-accepted-rules table")).toBeVisible();
    }

    // Rejected rules must stay visible (not vanish): reject one, confirm it
    // shows up in the Rejected section with a Restore action, then restore it.
    const reject = page.locator('#inspect-review-queue button', { hasText: "Reject" }).first();
    if (await reject.count()) {
      await reject.click();
      await page.waitForTimeout(500);
      const rejTable = page.locator("#inspect-rejected-rules table");
      await expect(rejTable).toBeVisible();
      const restore = rejTable.locator("button", { hasText: "Restore" }).first();
      await expect(restore).toBeVisible();
      await restore.click(); // cleanup → back to review queue
      await page.waitForTimeout(300);
    }

    expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
  });

  test("mode segmented control switches to Dry-run; Deviations tab renders", async ({ page }) => {
    const errors = [];
    page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(String(e)));

    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.locator('[data-page="inspect"]').click();
    await page.locator('#page-inspect .tab-btn', { hasText: "Profile" }).click();

    // Flip Observe → Dry-run via the segmented control; the masthead chip and
    // the description update to reflect the new mode.
    await page.locator('#inspect-mode-seg button[data-mode="dryrun"]').click();
    await expect(page.locator("#inspect-mode-chip")).toHaveText(/Dry-run/, { timeout: 10_000 });
    await expect(page.locator('#inspect-mode-seg button[data-mode="dryrun"]')).toHaveClass(/active/);

    // Deviations tab renders a table or an honest empty state.
    await page.locator('#page-inspect .tab-btn', { hasText: "Deviations" }).click();
    await expect(page.locator("#inspect-tab-deviations")).toHaveClass(/active/);
    await expect(page.locator("#inspect-deviations")).toBeVisible();

    // Restore observe so the test is idempotent against the shared demo server.
    await page.locator('#page-inspect .tab-btn', { hasText: "Profile" }).click();
    await page.locator('#inspect-mode-seg button[data-mode="observe"]').click();
    await expect(page.locator("#inspect-mode-chip")).toHaveText(/Observe/, { timeout: 10_000 });

    expect(errors, `console errors: ${errors.join("\n")}`).toEqual([]);
  });

  test("Enforce is gated behind a confirmation (Cancel does not enforce)", async ({ page }) => {
    // This test deliberately only opens + cancels the confirm — it must NOT
    // actually switch the shared demo server into enforce mode.
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.locator('[data-page="inspect"]').click();
    await page.locator('#page-inspect .tab-btn', { hasText: "Profile" }).click();

    // Clicking Enforce reveals a confirmation with an impact warning — it does
    // not change the mode yet.
    await page.locator('#inspect-mode-seg button[data-mode="enforce"]').click();
    const confirm = page.locator("#inspect-enforce-confirm");
    await expect(confirm).toBeVisible();
    await expect(confirm).toContainText(/block/i);
    await expect(page.locator("#inspect-mode-chip")).not.toHaveText(/Enforce/);

    // Cancel dismisses it; mode stays unchanged.
    await confirm.locator("button", { hasText: "Cancel" }).click();
    await expect(confirm).toBeHidden();
    await expect(page.locator("#inspect-mode-chip")).not.toHaveText(/Enforce/);
  });
});
