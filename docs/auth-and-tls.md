# Authentication & TLS

Every source supports optional authentication and TLS configuration — either through the Web UI under *Sources → Add/Edit Source*, or directly in `sources.yaml`.

## Basic Auth

```yaml
sources:
  - name: prometheus-prod
    type: prometheus
    url: https://prometheus.internal:9090
    enabled: true
    auth:
      type: basic
      username: admin
      password: "${PROM_PASSWORD}"
```

Grafana Cloud uses Basic Auth with your numeric instance ID as username and an API token as password. The instance ID for Prometheus and Loki is different — check *Connections → Data sources* in your Grafana Cloud stack.

## Bearer Token

Common for OAuth2 proxies and managed services that issue API tokens.

```yaml
sources:
  - name: grafana-cloud-metrics
    type: prometheus
    url: https://prometheus-us-central1.grafana.net/api/prom
    enabled: true
    auth:
      type: bearer
      token: "${GRAFANA_TOKEN}"
```

## Custom CA Certificate

For self-signed certs, supply your CA instead of disabling verification:

```yaml
sources:
  - name: prometheus-internal
    type: prometheus
    url: https://prometheus.corp:9090
    enabled: true
    tls:
      caCert: /etc/ssl/custom-ca.pem
```

## Mutual TLS (mTLS)

Client certificate authentication:

```yaml
sources:
  - name: prometheus-mtls
    type: prometheus
    url: https://prometheus.secure:9090
    enabled: true
    tls:
      caCert:     /etc/ssl/ca.pem
      clientCert: /etc/ssl/client.pem
      clientKey:  /etc/ssl/client-key.pem
```

## Skip TLS Verification

Last resort for development environments without a usable CA:

```yaml
sources:
  - name: prometheus-dev
    type: prometheus
    url: https://prometheus.dev:9090
    enabled: true
    tls:
      skipVerify: true
```

Prefer `caCert` over `skipVerify` — verification still catches MITM, expired certs, and hostname mismatches.
