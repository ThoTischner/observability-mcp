import { z } from "zod";

// Zod schema for connector plugin manifests. Mirror of the TS type in
// ./index.ts (ConnectorManifest); kept here so both server and plugin
// authors can import and validate at runtime.
//
// Bumping `schemaVersion` is a breaking change for the plugin contract.
// See docs/plugin-architecture.md for the deprecation policy.

export const manifestSchema = z.object({
  schemaVersion: z.literal(1),
  name: z.string().min(1).regex(/^[a-z][a-z0-9-]*$/, {
    message: "name must be kebab-case lowercase ASCII",
  }),
  displayName: z.string().min(1),
  version: z.string().regex(/^\d+\.\d+\.\d+(-[a-z0-9.-]+)?$/, {
    message: "version must be semver",
  }),
  description: z.string().min(1),
  signalTypes: z.array(z.enum(["metrics", "logs", "traces", "topology"])).min(1),
  homepage: z.string().url().optional(),
  license: z.string().optional(),
  logo: z.string().optional(),
  configSchema: z.unknown().optional(),
  capabilities: z
    .object({
      queryMetrics: z.boolean().optional(),
      queryLogs: z.boolean().optional(),
      queryLogAggregate: z.boolean().optional(),
      queryTraces: z.boolean().optional(),
      listServices: z.boolean().optional(),
      listAvailableMetrics: z.boolean().optional(),
      // Topology-provider capabilities (e.g. the Kubernetes connector).
      listResources: z.boolean().optional(),
      listEdges: z.boolean().optional(),
      getTopologySnapshot: z.boolean().optional(),
      watchTopology: z.boolean().optional(),
    })
    .optional(),
  compat: z
    .object({
      serverVersion: z.string().optional(),
    })
    .optional(),
  // Subresource-integrity-style digest of the plugin entry file
  // ("sha256-<base64>"). When the server runs with VERIFY_PLUGINS=true
  // this MUST be present and match the on-disk entry, and the manifest
  // itself MUST carry a valid detached signature. Airgapped-friendly:
  // verification is fully offline against a local trust-root key.
  integrity: z
    .string()
    .regex(/^sha256-[A-Za-z0-9+/]+=*$/, {
      message: 'integrity must be "sha256-<base64>"',
    })
    .optional(),
  // Lifecycle hooks the plugin wants to fire at. Each entry points to
  // a module path INSIDE the plugin's bundled files. The loader
  // resolves the module relative to the plugin root, imports its
  // default export as the handler, and registers it on the gateway's
  // HookRegistry. Hot-reloadable: install/upgrade of a plugin
  // re-registers its hooks without restart.
  hooks: z
    .array(
      z.object({
        kind: z.enum([
          "tool_pre_invoke",
          "tool_post_invoke",
          "resource_pre_fetch",
          "resource_post_fetch",
          "prompt_pre_fetch",
          "prompt_post_fetch",
        ]),
        module: z.string().min(1),
        priority: z.number().int().optional(),
        mode: z.enum(["enforce", "permissive", "disabled"]).optional(),
      }),
    )
    .optional(),
});

export type ValidatedConnectorManifest = z.infer<typeof manifestSchema>;
