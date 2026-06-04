import { test, expect, request } from "@playwright/test";

const BASE = process.env.OMCP_UI_BASE || "http://localhost:3000";

// Pin the new Products page UI surfaces shipped in the card-redesign
// slice. The CI integration job seeds two products via PUT
// /api/products/:id, then this spec asserts:
//   - The "About Products" leitfaden card renders, has the three
//     headings, and can be collapsed via click on its header.
//   - The view-toggle (Cards / Table) renders and switches view
//     mode, with the choice persisted to localStorage.
//   - At least one product card renders with the seeded brand
//     colour applied to its left rail.
//   - The empty-state templates are NOT rendered when products
//     exist (negative control).

test.describe("Products UI", () => {
  test.beforeAll(async () => {
    // Seed two products via the API so the assertions below have
    // something to render against. Anonymous mode = no auth needed
    // in CI / local demo.
    const api = await request.newContext({ baseURL: BASE });
    await api.put("/api/products/playwright-ops", {
      data: {
        id: "playwright-ops",
        name: "Playwright Ops Bundle",
        description: "Synthetic product for the playwright UI smoke.",
        status: "published",
        tools: ["query_logs", "query_metrics"],
        branding: { color: "#3178c6" },
      },
    });
    await api.dispose();
  });

  test.afterAll(async () => {
    const api = await request.newContext({ baseURL: BASE });
    await api.delete("/api/products/playwright-ops");
    await api.dispose();
  });

  test("Products page renders leitfaden + card grid with branding", async ({ page }) => {
    await page.goto(BASE);
    await page.click("[data-page=products]");
    await page.waitForSelector("#page-products.active");

    // Leitfaden card present with all three sections.
    const leitfaden = page.locator("#mcp-products-leitfaden");
    await expect(leitfaden).toBeVisible();
    await expect(leitfaden.locator("h3", { hasText: "What is a product?" })).toBeVisible();
    await expect(leitfaden.locator("h3", { hasText: "When do I need one?" })).toBeVisible();
    await expect(leitfaden.locator("h3", { hasText: "How do agents pick one up?" })).toBeVisible();

    // View-toggle present, defaulting to cards.
    const cardsBtn = page.locator("#mcp-pv-cards");
    const tableBtn = page.locator("#mcp-pv-table");
    await expect(cardsBtn).toBeVisible();
    await expect(tableBtn).toBeVisible();
    await expect(cardsBtn).toHaveClass(/active/);

    // At least one product card with branding rail.
    const card = page.locator(".pcard").first();
    await expect(card).toBeVisible();
    const rail = card.locator(".pcard-rail");
    await expect(rail).toBeVisible();
    // The seeded product carries #3178c6; rgb form is what the
    // browser exposes via getComputedStyle.
    const railBg = await rail.evaluate((el) => getComputedStyle(el).backgroundColor);
    expect(railBg).toMatch(/^rgb\(49,\s*120,\s*198\)/);

    // Empty-state templates are NOT shown when products exist.
    await expect(page.locator(".pempty-templates")).toHaveCount(0);
  });

  test("Leitfaden collapse persists across reloads", async ({ page }) => {
    await page.goto(BASE);
    await page.click("[data-page=products]");
    await page.waitForSelector("#page-products.active");
    const card = page.locator("#mcp-products-leitfaden");
    await expect(card).not.toHaveClass(/collapsed/);
    // Click the header to collapse.
    await card.locator(".card-header").click();
    await expect(card).toHaveClass(/collapsed/);
    // Reload — collapsed state survives via localStorage.
    await page.reload();
    await page.click("[data-page=products]");
    await page.waitForSelector("#page-products.active");
    await expect(page.locator("#mcp-products-leitfaden")).toHaveClass(/collapsed/);
    // Restore for the next test.
    await page.locator("#mcp-products-leitfaden .card-header").click();
  });

  test("Agent preview — /api/products/:id/preview returns filtered tools + card 'Preview as agent' opens the modal", async ({ page, request: apiReq }) => {
    // The endpoint reflects the same filter the /mcp transport
    // applies, so this test doubles as a contract pin between the
    // server's tools/list filter and the UI preview affordance.
    const resp = await apiReq.get("/api/products/playwright-ops/preview");
    expect(resp.status()).toBe(200);
    const body = await resp.json();
    expect(body.unrestricted).toBe(false);
    expect(body.tools.map((t) => t.name).sort()).toEqual(["query_logs", "query_metrics"]);
    // Open the page + click the per-card preview button.
    await page.goto(BASE);
    await page.click("[data-page=products]");
    await page.waitForSelector("#page-products.active");
    await page.locator(".pcard").first().locator("button:has-text(\"Preview as agent\")").click();
    await expect(page.locator("#mcp-agent-preview-modal.open")).toBeVisible();
    await expect(page.locator("#mcp-agent-preview-title")).toContainText("Playwright Ops Bundle");
    await expect(page.locator("#mcp-agent-preview-list")).toContainText("query_logs");
    await expect(page.locator("#mcp-agent-preview-list")).toContainText("query_metrics");
    // Negative control: a tool NOT in the allow-list isn't rendered.
    await expect(page.locator("#mcp-agent-preview-list")).not.toContainText("get_topology");
    // Close + sanity check.
    await page.locator("#mcp-agent-preview-modal button:has-text(\"Close\")").click();
    await expect(page.locator("#mcp-agent-preview-modal.open")).toBeHidden();
  });

  test("Wizard Review pane — embedded agent preview reflects the in-form tools selection (no server roundtrip)", async ({ page }) => {
    // Delete the seeded product so the empty-state path renders the
    // templates we click in the next step.
    const api = await request.newContext({ baseURL: BASE });
    await api.delete("/api/products/playwright-ops");
    await api.dispose();
    await page.goto(BASE);
    await page.click("[data-page=products]");
    await page.waitForSelector("#page-products.active");
    // Open via the Ops template — pre-checks 4 tools.
    await page.locator(".pempty-tpl").first().click();
    await page.locator("#mcp-product-id").fill("playwright-wiz-preview");
    // Jump straight to Review.
    await page.click('.wiz-step-btn[data-step="4"]');
    await expect(page.locator("#wiz-pane-4")).toBeVisible();
    // Embedded preview shows the 4 ops-bundle tools.
    const preview = page.locator("#mcp-wiz-agent-preview");
    await expect(preview).toBeVisible();
    for (const t of ["query_logs", "query_metrics", "get_service_health", "detect_anomalies"]) {
      await expect(preview).toContainText(t);
    }
    // A tool NOT in the template is not in the preview.
    await expect(preview).not.toContainText("get_topology");
    // Cancel + re-seed.
    await page.locator("button:has-text(\"Cancel\")").first().click();
    const api2 = await request.newContext({ baseURL: BASE });
    await api2.put("/api/products/playwright-ops", {
      data: {
        id: "playwright-ops", name: "Playwright Ops Bundle",
        status: "published", tools: ["query_logs", "query_metrics"],
        branding: { color: "#3178c6" },
      },
    });
    await api2.dispose();
  });

  test("Wizard — 4 panes, Back/Next navigation, validation gates Identity, Review summary", async ({ page }) => {
    // Delete the seeded product so the empty-state templates path
    // gives us a clean wizard open.
    const api = await request.newContext({ baseURL: BASE });
    await api.delete("/api/products/playwright-ops");
    await api.dispose();
    await page.goto(BASE);
    await page.click("[data-page=products]");
    await page.waitForSelector("#page-products.active");

    // Open the modal via a template — wizard starts on step 1.
    await page.locator(".pempty-tpl").first().click();
    await expect(page.locator("#mcp-product-modal.open")).toBeVisible();

    // Step 1 (Identity) visible, others hidden.
    await expect(page.locator("#wiz-pane-1")).toBeVisible();
    await expect(page.locator("#wiz-pane-2")).toBeHidden();
    await expect(page.locator("#wiz-pane-3")).toBeHidden();
    await expect(page.locator("#wiz-pane-4")).toBeHidden();
    // Stepper has 4 bullets, step 1 is active.
    await expect(page.locator('.wiz-step-btn[data-active="true"][data-step="1"]')).toBeVisible();

    // Without an id, Next must NOT advance.
    await page.locator("#mcp-product-id").fill("");
    await page.click("#mcp-wiz-next");
    await expect(page.locator("#wiz-pane-1")).toBeVisible();
    await expect(page.locator("#mcp-product-error")).toBeVisible();

    // Fill id + name, advance to step 2 (Tools).
    await page.locator("#mcp-product-id").fill("playwright-wizard");
    // Name pre-filled by the Ops template; verify it.
    await expect(page.locator("#mcp-product-name")).toHaveValue("Ops Bundle");
    await page.click("#mcp-wiz-next");
    await expect(page.locator("#wiz-pane-2")).toBeVisible();
    await expect(page.locator(".tools-picker")).toBeVisible();

    // Step 3 (Scope & branding).
    await page.click("#mcp-wiz-next");
    await expect(page.locator("#wiz-pane-3")).toBeVisible();
    await page.locator("#mcp-product-color").fill("#7c3aed");

    // Step 4 (Review) — Next button gone, Save visible.
    await page.click("#mcp-wiz-next");
    await expect(page.locator("#wiz-pane-4")).toBeVisible();
    await expect(page.locator("#mcp-wiz-next")).toBeHidden();
    await expect(page.locator("#mcp-wiz-save")).toBeVisible();
    // Review summary mentions the chosen id + the brand colour code.
    await expect(page.locator("#mcp-wiz-review")).toContainText("playwright-wizard");
    await expect(page.locator("#mcp-wiz-review")).toContainText("#7c3aed");
    // The colour swatch is rendered.
    await expect(page.locator(".wiz-review-swatch")).toBeVisible();

    // Back from step 4 → step 3 (Next reappears, Save hides).
    await page.click("#mcp-wiz-back");
    await expect(page.locator("#wiz-pane-3")).toBeVisible();
    await expect(page.locator("#mcp-wiz-save")).toBeHidden();
    await expect(page.locator("#mcp-wiz-next")).toBeVisible();

    // Stepper bullets are clickable — jump back to step 1 directly.
    await page.click('.wiz-step-btn[data-step="1"]');
    await expect(page.locator("#wiz-pane-1")).toBeVisible();

    // Cancel + restore seed for downstream tests.
    await page.locator("button:has-text(\"Cancel\")").first().click();
    const api2 = await request.newContext({ baseURL: BASE });
    await api2.put("/api/products/playwright-ops", {
      data: {
        id: "playwright-ops", name: "Playwright Ops Bundle",
        status: "published", tools: ["query_logs", "query_metrics"],
        branding: { color: "#3178c6" },
      },
    });
    await api2.dispose();
  });

  test("Tools picker — renders categories, syncs selections to the hidden textarea, prefills from a template", async ({ page }) => {
    // Delete the seeded product so the empty-state templates render
    // a "+ click to open with tools prefilled" path we can exercise.
    const api = await request.newContext({ baseURL: BASE });
    await api.delete("/api/products/playwright-ops");
    await api.dispose();
    await page.goto(BASE);
    await page.click("[data-page=products]");
    await page.waitForSelector("#page-products.active");
    await expect(page.locator(".pempty-templates")).toBeVisible();
    // Click "Ops Bundle" — opens the modal prefilled with 4 tools.
    await page.locator(".pempty-tpl").nth(0).click();
    await expect(page.locator("#mcp-product-modal.open")).toBeVisible();
    // Picker categories present.
    await expect(page.locator(".tools-picker .tp-cat", { hasText: "Discovery" })).toBeVisible();
    await expect(page.locator(".tools-picker .tp-cat", { hasText: "Query" })).toBeVisible();
    await expect(page.locator(".tools-picker .tp-cat", { hasText: "Diagnose" })).toBeVisible();
    await expect(page.locator(".tools-picker .tp-cat", { hasText: "Topology" })).toBeVisible();
    // The 4 ops-bundle tools are pre-checked.
    const opsTools = ["query_logs", "query_metrics", "get_service_health", "detect_anomalies"];
    for (const t of opsTools) {
      await expect(page.locator(`.tools-picker input[data-tool="${t}"]`)).toBeChecked();
    }
    // Tools NOT in the template are unchecked.
    await expect(page.locator(`.tools-picker input[data-tool="list_sources"]`)).not.toBeChecked();
    // Toggle one off and verify the hidden textarea reflects it.
    await page.locator(`.tools-picker input[data-tool="detect_anomalies"]`).click();
    const textareaValue = await page.locator("#mcp-product-tools").inputValue();
    const lines = textareaValue.split("\n").filter(Boolean).sort();
    expect(lines).toEqual(["get_service_health", "query_logs", "query_metrics"]);
    // "Select all" enables every tool.
    await page.locator(".tools-picker .tp-actions button", { hasText: "Select all" }).click();
    const all = (await page.locator("#mcp-product-tools").inputValue()).split("\n").filter(Boolean);
    expect(all.length).toBe(8);
    // Cancel + re-seed for remaining tests.
    await page.locator("button:has-text(\"Cancel\")").first().click();
    const api2 = await request.newContext({ baseURL: BASE });
    await api2.put("/api/products/playwright-ops", {
      data: {
        id: "playwright-ops", name: "Playwright Ops Bundle",
        status: "published", tools: ["query_logs", "query_metrics"],
        branding: { color: "#3178c6" },
      },
    });
    await api2.dispose();
  });

  test("Empty-state templates prefill the product modal (regression: was a no-op in initial slice)", async ({ page }) => {
    // Delete the seeded product so the empty state with templates
    // renders. afterAll restores ordering for the next workers.
    const api = await request.newContext({ baseURL: BASE });
    await api.delete("/api/products/playwright-ops");
    await api.dispose();
    await page.goto(BASE);
    await page.click("[data-page=products]");
    await page.waitForSelector("#page-products.active");
    await expect(page.locator(".pempty-templates")).toBeVisible();
    // Click the "Ops Bundle" template — the modal must open with
    // name + tools + status prefilled from the template.
    await page.locator(".pempty-tpl").nth(0).click();
    await expect(page.locator("#mcp-product-modal.open")).toBeVisible();
    await expect(page.locator("#mcp-product-name")).toHaveValue("Ops Bundle");
    await expect(page.locator("#mcp-product-status")).toHaveValue("staging");
    const toolsLines = await page.locator("#mcp-product-tools").inputValue();
    expect(toolsLines.split("\n").sort()).toEqual(["detect_anomalies", "get_service_health", "query_logs", "query_metrics"]);
    // Cancel + re-seed for the remaining tests.
    await page.locator("button:has-text(\"Cancel\")").first().click();
    const api2 = await request.newContext({ baseURL: BASE });
    await api2.put("/api/products/playwright-ops", {
      data: {
        id: "playwright-ops",
        name: "Playwright Ops Bundle",
        status: "published",
        tools: ["query_logs", "query_metrics"],
        branding: { color: "#3178c6" },
      },
    });
    await api2.dispose();
  });

  test("View-toggle switches the catalog between cards and table", async ({ page }) => {
    await page.goto(BASE);
    await page.click("[data-page=products]");
    await page.waitForSelector("#page-products.active");
    await expect(page.locator(".pcard-grid")).toBeVisible();
    await page.click("#mcp-pv-table");
    await expect(page.locator(".data-table")).toBeVisible();
    await expect(page.locator(".pcard-grid")).toHaveCount(0);
    // Reload — view mode persisted.
    await page.reload();
    await page.click("[data-page=products]");
    await page.waitForSelector("#page-products.active");
    await expect(page.locator(".data-table")).toBeVisible();
    // Restore default.
    await page.click("#mcp-pv-cards");
  });
});
