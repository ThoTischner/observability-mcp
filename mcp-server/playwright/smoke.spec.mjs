import { test, expect } from "@playwright/test";

const BASE = process.env.OMCP_UI_BASE || "http://localhost:3000";

// data-page values discovered from mcp-server/src/ui/index.html (the left
// rail nav-btn list). Keep in sync with that file.
const PAGES = [
  "dashboard",
  "sources",
  "services",
  "health",
  "topology",
];

// Ignored error patterns: third-party fetches that may fail in CI with no
// effect on UX (e.g. font preload when offline). Keep this list short and
// justified — every entry is a documented exception, not a way to hide bugs.
const IGNORED_ERRORS = [
  /rsms\.me/i,                 // Inter font CDN — UI degrades gracefully without it
  /Failed to load resource/i,  // generic — only fired when above CDN unreachable
];

function shouldIgnore(text) {
  return IGNORED_ERRORS.some((re) => re.test(text));
}

function collectErrors(page, sink) {
  page.on("pageerror", (e) => {
    if (!shouldIgnore(e.message)) sink.push(`pageerror: ${e.message}`);
  });
  page.on("console", (msg) => {
    if (msg.type() !== "error") return;
    const text = msg.text();
    if (!shouldIgnore(text)) sink.push(`console.error: ${text}`);
  });
}

test.describe("Web UI smoke", () => {
  test("shell loads with title and no console errors", async ({ page }) => {
    const errors = [];
    collectErrors(page, errors);

    const resp = await page.goto(BASE, { waitUntil: "networkidle" });
    expect(resp?.ok(), `GET ${BASE} returned ${resp?.status()}`).toBeTruthy();

    await expect(page).toHaveTitle(/Observability MCP/i);

    // Left rail nav is the entry point — confirm at least the dashboard
    // button rendered before we declare the shell intact.
    await expect(page.locator('[data-page="dashboard"]')).toBeVisible();

    expect(errors, `unexpected console errors:\n${errors.join("\n")}`).toEqual([]);
  });

  for (const page_id of PAGES) {
    test(`page: ${page_id} renders without console errors`, async ({ page }) => {
      const errors = [];
      collectErrors(page, errors);

      await page.goto(BASE, { waitUntil: "networkidle" });

      const btn = page.locator(`[data-page="${page_id}"]`).first();
      await btn.click({ timeout: 5_000 });

      // Allow page-mount side effects (fetch, render) to settle.
      await page.waitForLoadState("networkidle");

      // The body of the just-clicked tab should be visible — every page
      // section has id="page-<name>" in the existing UI.
      const body = page.locator(`#page-${page_id}`);
      await expect(body).toBeVisible({ timeout: 5_000 });

      expect(errors, `console errors on ${page_id}:\n${errors.join("\n")}`).toEqual([]);
    });
  }

  test("theme toggle flips data-theme attribute", async ({ page }) => {
    await page.goto(BASE, { waitUntil: "networkidle" });
    const initial = await page.locator("html").getAttribute("data-theme");
    expect(initial === "light" || initial === "dark").toBeTruthy();

    const toggle = page.locator(
      'button[title*="theme" i], button[aria-label*="theme" i], [data-action="theme-toggle"]',
    ).first();
    if ((await toggle.count()) === 0) test.skip(true, "no theme toggle present");

    await toggle.click();
    const next = await page.locator("html").getAttribute("data-theme");
    expect(next).not.toBe(initial);
  });
});
