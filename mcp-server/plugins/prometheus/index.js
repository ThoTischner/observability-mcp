// Filesystem plugin shim — re-exports the existing built-in
// implementation so the same code path runs whether the connector is
// loaded from the builtin registry or from /app/plugins/prometheus.
//
// Once we ship the SDK as @thotischner/observability-mcp-sdk on npm
// (roadmap step 4b), this file will become a real standalone package
// that imports the SDK and ships its own implementation. For now it
// lives next to the server it eats its own dogfood from.

import { PrometheusConnector } from "../../dist/connectors/prometheus.js";

export default function create() {
  return new PrometheusConnector();
}
