// Filesystem plugin shim for Loki. See ../prometheus/index.js for the
// rationale — same pattern, awaiting the SDK npm package before the
// plugin can stand on its own.

import { LokiConnector } from "../../dist/connectors/loki.js";

export default function create() {
  return new LokiConnector();
}
