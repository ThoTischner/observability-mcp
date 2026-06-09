import { test, expect } from "@playwright/test";

const BASE = process.env.OMCP_UI_BASE || "http://localhost:3000";

// Render-smoke for the rail tabs that had NO playwright coverage before the
// post-#415 hardening sweep (smoke.spec covers dashboard/sources/services/
// health/topology; products/playground/topology/access/policies/tables have
// dedicated specs). Each tab: navigate via the rail, assert its #page-<id>
// body becomes visible, and assert no console errors fired on mount.
//
// Some tabs are conditionally shown depending on deployment config (e.g.
// audit/entitlement may be gated). When the nav item isn't present in this
// build we skip rather than fail — the assertion still runs wherever the tab
// is exposed (incl. the demo stack ui-smoke job).
const PAGES = ["postmortems", "audit", "entitlement"];

const IGNORED_ERRORS = [
  /rsms\.me/i, // Inter font CDN — UI degrades gracefully without it
  /Failed to load resource/i, // generic — only fired when the above CDN is unreachable
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

test.describe("Web UI — previously-uncovered tabs render", () => {
  for (const page_id of PAGES) {
    test(`page: ${page_id} navigates and renders without console errors`, async ({ page }) => {
      const errors = [];
      collectErrors(page, errors);

      await page.goto(BASE, { waitUntil: "networkidle" });

      const btn = page.locator(`[data-page="${page_id}"]`).first();
      if ((await btn.count()) === 0 || !(await btn.isVisible())) {
        test.skip(true, `tab "${page_id}" not exposed in this build/config`);
      }

      await btn.click({ timeout: 5_000 });
      await page.waitForLoadState("networkidle");

      await expect(page.locator(`#page-${page_id}`)).toBeVisible({ timeout: 5_000 });

      expect(errors, `console errors on ${page_id}:\n${errors.join("\n")}`).toEqual([]);
    });
  }
});
