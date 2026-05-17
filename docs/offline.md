# Verifiable Offline Mode

observability-mcp is air-gapped by design and **makes no telemetry,
analytics, phone-home, or update-check calls**. The only outbound traffic it
ever performs is to:

1. the **source backends you configure** (Prometheus/Loki/… URLs), and
2. a **plugin artifact URL** you or your configured registry explicitly ask
   it to install.

Nothing else leaves the process — ever.

## How this is guaranteed (not just claimed)

**Static guard (always-on, CI):** `mcp-server/src/net/egress-policy.ts`
defines the egress allowlist and forbidden-SDK rules;
`egress-policy.test.ts` scans every source file and **fails the build** if an
outbound call appears outside the allowlist, or if any analytics/telemetry
SDK is imported anywhere. The "no data egress" property therefore cannot
silently regress.

**End-to-end proof (on demand):**

```bash
make test-offline
```

This builds the image, starts it on an **`--internal` Docker network with no
internet route** and **zero sources configured**, and asserts `/healthz` and
`/readyz` from an isolated sibling container. If the server needed any
external call to boot or serve health, this fails.

## Running fully air-gapped

- No runtime `npm install` (dependencies are baked into the image).
- Plugin tarballs can be baked in; set `PLUGIN_REQUIRE_SIGNATURE=true` to
  reject anything unsigned.
- Leave `PROMETHEUS_URL` / `LOKI_URL` empty and add sources later via the Web
  UI or `config/sources.yaml` — the server starts healthy with no sources.

See also [airgapped-deployment.md](airgapped-deployment.md).
