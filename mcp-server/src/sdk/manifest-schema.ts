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
  signalTypes: z.array(z.enum(["metrics", "logs", "traces"])).min(1),
  homepage: z.string().url().optional(),
  license: z.string().optional(),
  logo: z.string().optional(),
  configSchema: z.unknown().optional(),
  capabilities: z
    .object({
      queryMetrics: z.boolean().optional(),
      queryLogs: z.boolean().optional(),
      listServices: z.boolean().optional(),
      listAvailableMetrics: z.boolean().optional(),
    })
    .optional(),
  compat: z
    .object({
      serverVersion: z.string().optional(),
    })
    .optional(),
});

export type ValidatedConnectorManifest = z.infer<typeof manifestSchema>;
