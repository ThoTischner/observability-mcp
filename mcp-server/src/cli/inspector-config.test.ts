import { test } from "node:test";
import assert from "node:assert/strict";

import { buildInspectorConfig } from "./inspector-config.js";

test("buildInspectorConfig: defaults to localhost:3000/mcp, no headers, observability-mcp server name", () => {
  const cfg = buildInspectorConfig({});
  assert.deepEqual(cfg, {
    mcpServers: {
      "observability-mcp": {
        url: "http://localhost:3000/mcp",
      },
    },
  });
});

test("buildInspectorConfig: trims trailing slash from base URL", () => {
  const cfg = buildInspectorConfig({ OMCP_BASE_URL: "https://gw.example.com/" });
  assert.equal(cfg.mcpServers["observability-mcp"].url, "https://gw.example.com/mcp");
});

test("buildInspectorConfig: token populates Authorization Bearer", () => {
  const cfg = buildInspectorConfig({
    OMCP_INSPECTOR_TOKEN: "tok-abc",
  });
  assert.equal(
    cfg.mcpServers["observability-mcp"].headers?.Authorization,
    "Bearer tok-abc",
  );
});

test("buildInspectorConfig: custom server name", () => {
  const cfg = buildInspectorConfig({
    OMCP_INSPECTOR_SERVER_NAME: "my-gateway",
  });
  assert.ok("my-gateway" in cfg.mcpServers);
});

test("buildInspectorConfig: empty token trimmed → no headers key", () => {
  const cfg = buildInspectorConfig({ OMCP_INSPECTOR_TOKEN: "   " });
  assert.equal(cfg.mcpServers["observability-mcp"].headers, undefined);
});
