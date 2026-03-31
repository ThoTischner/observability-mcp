import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "node:https";
import { writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildTlsAgent } from "./tls.js";
import type { SourceConfig } from "../types.js";

const TMP_DIR = join(tmpdir(), "tls-test-" + Date.now());

function makeConfig(overrides: Partial<SourceConfig> = {}): SourceConfig {
  return { name: "test", type: "prometheus", url: "https://localhost:9090", enabled: true, ...overrides };
}

describe("buildTlsAgent", () => {
  it("returns undefined when no TLS config is set", () => {
    const agent = buildTlsAgent(makeConfig());
    assert.equal(agent, undefined);
  });

  it("returns undefined for plain HTTP URLs without TLS config", () => {
    const agent = buildTlsAgent(makeConfig({ url: "http://localhost:9090" }));
    assert.equal(agent, undefined);
  });

  it("returns Agent with rejectUnauthorized=false when skipVerify is true", () => {
    const agent = buildTlsAgent(makeConfig({ tls: { skipVerify: true } }));
    assert.ok(agent instanceof Agent);
    assert.equal((agent.options as any).rejectUnauthorized, false);
  });

  it("supports legacy tlsSkipVerify field", () => {
    const agent = buildTlsAgent(makeConfig({ tlsSkipVerify: true }));
    assert.ok(agent instanceof Agent);
    assert.equal((agent.options as any).rejectUnauthorized, false);
  });

  it("prefers tls.skipVerify over legacy tlsSkipVerify", () => {
    const agent = buildTlsAgent(makeConfig({
      tlsSkipVerify: false,
      tls: { skipVerify: true },
    }));
    assert.ok(agent instanceof Agent);
    assert.equal((agent.options as any).rejectUnauthorized, false);
  });

  describe("with certificate files", () => {
    before(() => {
      mkdirSync(TMP_DIR, { recursive: true });
      writeFileSync(join(TMP_DIR, "ca.pem"), "-----BEGIN CERTIFICATE-----\nfake-ca\n-----END CERTIFICATE-----\n");
      writeFileSync(join(TMP_DIR, "client.pem"), "-----BEGIN CERTIFICATE-----\nfake-client\n-----END CERTIFICATE-----\n");
      writeFileSync(join(TMP_DIR, "client-key.pem"), "-----BEGIN PRIVATE KEY-----\nfake-key\n-----END PRIVATE KEY-----\n");
    });

    after(() => {
      rmSync(TMP_DIR, { recursive: true, force: true });
    });

    it("loads custom CA certificate", () => {
      const agent = buildTlsAgent(makeConfig({
        tls: { caCert: join(TMP_DIR, "ca.pem") },
      }));
      assert.ok(agent instanceof Agent);
      assert.ok((agent.options as any).ca);
    });

    it("loads client cert and key for mTLS", () => {
      const agent = buildTlsAgent(makeConfig({
        tls: {
          clientCert: join(TMP_DIR, "client.pem"),
          clientKey: join(TMP_DIR, "client-key.pem"),
        },
      }));
      assert.ok(agent instanceof Agent);
      assert.ok((agent.options as any).cert);
      assert.ok((agent.options as any).key);
    });

    it("combines CA + mTLS + skipVerify", () => {
      const agent = buildTlsAgent(makeConfig({
        tls: {
          skipVerify: true,
          caCert: join(TMP_DIR, "ca.pem"),
          clientCert: join(TMP_DIR, "client.pem"),
          clientKey: join(TMP_DIR, "client-key.pem"),
        },
      }));
      assert.ok(agent instanceof Agent);
      assert.equal((agent.options as any).rejectUnauthorized, false);
      assert.ok((agent.options as any).ca);
      assert.ok((agent.options as any).cert);
      assert.ok((agent.options as any).key);
    });

    it("ignores clientCert without clientKey (no cert/key set on agent)", () => {
      const agent = buildTlsAgent(makeConfig({
        tls: { clientCert: join(TMP_DIR, "client.pem") },
      }));
      // Agent is created (clientCert triggers it) but cert/key are not set without both
      assert.ok(agent instanceof Agent);
      assert.equal((agent.options as any).cert, undefined);
      assert.equal((agent.options as any).key, undefined);
    });
  });

  it("throws when CA cert file does not exist", () => {
    assert.throws(() => {
      buildTlsAgent(makeConfig({
        tls: { caCert: "/nonexistent/ca.pem" },
      }));
    });
  });
});
