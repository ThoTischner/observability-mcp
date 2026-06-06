#!/usr/bin/env node
// omcp-sdk-create-connector — scaffold a new connector skeleton.
//
// Usage:
//   npx @thotischner/observability-mcp-sdk create-connector my-connector
//
// Creates ./my-connector/ with manifest.json, package.json, src/index.ts,
// src/index.test.ts, README. The skeleton is intentionally tiny — the
// goal is "you have a compiling, signable plugin in 30 seconds, now
// fill in the body".

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

const TEMPLATES: Record<string, (name: string) => string> = {
  "manifest.json": (name) => JSON.stringify(
    {
      schemaVersion: 1,
      name,
      displayName: name.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()),
      version: "0.1.0",
      description: `${name} connector — TODO describe what backend this connects.`,
      signalTypes: ["metrics"],
      license: "Apache-2.0",
    },
    null,
    2,
  ),
  "package.json": (name) => JSON.stringify(
    {
      name: `@your-org/${name}-connector`,
      version: "0.1.0",
      type: "module",
      main: "./src/index.js",
      observabilityMcp: {
        name,
        kind: "connector",
      },
      dependencies: {
        "@thotischner/observability-mcp-sdk": "^2.0.0",
      },
    },
    null,
    2,
  ),
  "src/index.ts": (name) => `import type { ObservabilityConnector } from "@thotischner/observability-mcp-sdk";

export default class ${pascal(name)}Connector implements ObservabilityConnector {
  readonly name = "${name}";
  readonly type = "${name}";
  readonly signalType = "metrics" as const;

  async connect(_config: unknown): Promise<void> {
    // TODO: open the backend connection. Throw on irrecoverable misconfig.
  }
  async healthCheck(): Promise<{ healthy: boolean; message?: string }> {
    return { healthy: true };
  }
  async disconnect(): Promise<void> { /* close handles */ }

  getDefaultMetrics(): unknown[] { return []; }
  getMetrics(): unknown[] { return this.getDefaultMetrics(); }

  async listServices(): Promise<unknown[]> {
    return [];
  }
}
`,
  "src/index.test.ts": () => `import { test } from "node:test";
import assert from "node:assert/strict";
import Connector from "./index.js";

test("connector boots clean", async () => {
  const c = new Connector();
  await c.connect({});
  const h = await c.healthCheck();
  assert.equal(h.healthy, true);
  await c.disconnect();
});
`,
  "README.md": (name) => `# ${name} connector

Generated from \`omcp-sdk-create-connector\`. Implement \`connect()\`,
\`listServices()\`, and at least one of \`queryMetrics\` / \`queryLogs\` /
\`queryTraces\` / \`listResources\` to participate in the gateway.

See https://thotischner.github.io/observability-mcp/plugin-architecture/
for the full plugin contract.
`,
};

function pascal(s: string): string {
  return s
    .split(/[-_\s]/)
    .filter(Boolean)
    .map((p) => p.charAt(0).toUpperCase() + p.slice(1))
    .join("");
}

function main(): void {
  const name = process.argv[2];
  if (!name || !/^[a-z][a-z0-9-]*$/.test(name)) {
    console.error(
      "Usage: omcp-sdk-create-connector <name>\n  <name> must be kebab-case ASCII starting with a letter.",
    );
    process.exit(1);
  }
  if (existsSync(name)) {
    console.error(`Refusing to overwrite existing directory: ${name}`);
    process.exit(1);
  }
  mkdirSync(join(name, "src"), { recursive: true });
  for (const [path, render] of Object.entries(TEMPLATES)) {
    writeFileSync(join(name, path), render(name), "utf8");
  }
  console.log(`✔ Scaffolded ${name}/`);
  console.log("\nNext steps:");
  console.log(`  cd ${name}`);
  console.log(`  npm install`);
  console.log(`  npm test`);
  console.log(`\nDocs: https://thotischner.github.io/observability-mcp/plugin-architecture/`);
}

main();
