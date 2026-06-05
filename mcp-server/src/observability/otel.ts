// OpenTelemetry self-instrumentation of the gateway.
//
// Opt-in via OMCP_OTEL_ENABLED=true; default off so the OSS demo and
// any deployment that does not run a collector stays silent. When on,
// the Node SDK auto-instruments HTTP (covers /api/* and /mcp routes
// out of the box) and exports to an OTLP/HTTP endpoint.
//
// Env:
//   OMCP_OTEL_ENABLED   true|1|yes to enable (default off)
//   OMCP_OTEL_ENDPOINT  OTLP/HTTP traces URL (default http://localhost:4318/v1/traces)
//   OMCP_OTEL_HEADERS   "key1=val1,key2=val2" for collector auth
//   OMCP_OTEL_SERVICE_NAME    override resource service.name (default observability-mcp)
//   OMCP_OTEL_SERVICE_VERSION override resource service.version (default from package.json at runtime)
//
// Imports are dynamic so the @opentelemetry/* packages stay outside the
// startup hot path when otel is disabled.

import { hostname } from "node:os";

export interface OtelInitResult {
  enabled: boolean;
  endpoint?: string;
  serviceName?: string;
  reason?: string;
}

let initialized = false;
let result: OtelInitResult = { enabled: false, reason: "init not called" };

export function isOtelEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return /^(1|true|yes|on)$/i.test(env.OMCP_OTEL_ENABLED ?? "");
}

export function otelStatus(): OtelInitResult {
  return result;
}

/**
 * Idempotent init. Returns synchronously; the SDK starts in the
 * background. Safe to call multiple times — the second call is a
 * no-op.
 */
export async function initOtel(
  opts: {
    serviceVersion?: string;
    env?: NodeJS.ProcessEnv;
  } = {},
): Promise<OtelInitResult> {
  if (initialized) return result;
  initialized = true;

  const env = opts.env ?? process.env;

  if (!isOtelEnabled(env)) {
    result = { enabled: false, reason: "OMCP_OTEL_ENABLED is off" };
    return result;
  }

  const endpoint =
    env.OMCP_OTEL_ENDPOINT ?? "http://localhost:4318/v1/traces";
  const serviceName = env.OMCP_OTEL_SERVICE_NAME ?? "observability-mcp";
  const serviceVersion =
    env.OMCP_OTEL_SERVICE_VERSION ?? opts.serviceVersion ?? "unknown";
  const headers = parseOtelHeaders(env.OMCP_OTEL_HEADERS);

  try {
    // Dynamic imports keep the cold-start overhead off the
    // OTEL-disabled path. Failures here log + degrade gracefully —
    // the gateway must never refuse to boot because tracing is
    // misconfigured.
    const { NodeSDK } = await import("@opentelemetry/sdk-node");
    const { OTLPTraceExporter } = await import(
      "@opentelemetry/exporter-trace-otlp-http"
    );
    const { resourceFromAttributes } = await import(
      "@opentelemetry/resources"
    );
    const { getNodeAutoInstrumentations } = await import(
      "@opentelemetry/auto-instrumentations-node"
    );
    const semconv = await import("@opentelemetry/semantic-conventions");

    const ATTR_SERVICE_NAME =
      (semconv as unknown as Record<string, string>).ATTR_SERVICE_NAME ??
      (semconv as unknown as Record<string, string>).SEMRESATTRS_SERVICE_NAME ??
      "service.name";
    const ATTR_SERVICE_VERSION =
      (semconv as unknown as Record<string, string>).ATTR_SERVICE_VERSION ??
      (semconv as unknown as Record<string, string>).SEMRESATTRS_SERVICE_VERSION ??
      "service.version";
    const ATTR_SERVICE_INSTANCE_ID =
      (semconv as unknown as Record<string, string>).ATTR_SERVICE_INSTANCE_ID ??
      (semconv as unknown as Record<string, string>).SEMRESATTRS_SERVICE_INSTANCE_ID ??
      "service.instance.id";

    const sdk = new NodeSDK({
      resource: resourceFromAttributes({
        [ATTR_SERVICE_NAME]: serviceName,
        [ATTR_SERVICE_VERSION]: serviceVersion,
        [ATTR_SERVICE_INSTANCE_ID]: hostname(),
      }),
      traceExporter: new OTLPTraceExporter({ url: endpoint, headers }),
      instrumentations: [
        getNodeAutoInstrumentations({
          // Filesystem instrumentation generates a span per fs call —
          // it explodes the trace volume for negligible value at the
          // gateway level. Off by default; operators can re-enable
          // via direct SDK config if they need it.
          "@opentelemetry/instrumentation-fs": { enabled: false },
        }),
      ],
    });

    sdk.start();

    // Best-effort flush on shutdown so in-flight spans reach the
    // collector during a rolling restart.
    process.on("SIGTERM", () => {
      sdk
        .shutdown()
        .catch((err: unknown) =>
          console.warn("OTel SDK shutdown failed:", err),
        );
    });

    result = { enabled: true, endpoint, serviceName };
    console.log(
      "OTel self-tracing enabled: exporting to %s as service.name=%s",
      endpoint,
      serviceName,
    );
    return result;
  } catch (err) {
    result = {
      enabled: false,
      reason: `OTel init failed: ${err instanceof Error ? err.message : String(err)}`,
    };
    console.warn(
      "OTel self-tracing requested but init failed; gateway continues without tracing. %s",
      result.reason,
    );
    return result;
  }
}

export function parseOtelHeaders(
  raw: string | undefined,
): Record<string, string> | undefined {
  if (!raw) return undefined;
  const out: Record<string, string> = {};
  for (const pair of raw.split(",")) {
    const [k, ...rest] = pair.split("=");
    const key = k?.trim();
    const value = rest.join("=").trim();
    if (key && value) out[key] = value;
  }
  return Object.keys(out).length === 0 ? undefined : out;
}

/** Test-only — resets internal state so re-init can be exercised. */
export function _resetOtelForTests(): void {
  initialized = false;
  result = { enabled: false, reason: "init not called" };
}
