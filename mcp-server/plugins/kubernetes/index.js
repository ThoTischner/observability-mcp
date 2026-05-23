// Filesystem plugin shim — re-exports the built-in implementation, same
// pattern as plugins/prometheus and plugins/loki.

import { KubernetesConnector } from "../../dist/connectors/kubernetes.js";

export default function create() {
  return new KubernetesConnector();
}
