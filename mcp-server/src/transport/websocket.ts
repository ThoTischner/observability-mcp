// WebSocket transport for MCP.
//
// Implements the @modelcontextprotocol/sdk Transport interface so the
// existing McpServer can speak JSON-RPC over a single WS connection
// without duplicating any tool registration code.
//
// Wire-format: one JSON-RPC message per WS frame (text). No batching,
// no framing tricks — the same shape an HTTP POST body carries today.
//
// Lifecycle:
//   - The HTTP upgrade handler authenticates the connection, creates
//     a WebSocketServerTransport wrapping the accepted socket, then
//     calls McpServer.connect(transport).
//   - The transport surfaces incoming messages via onmessage, sends
//     outgoing messages via ws.send(), and reports closure / errors
//     through onclose / onerror.
//   - A heartbeat ping is sent every PING_INTERVAL_MS; if no pong
//     arrives within PING_TIMEOUT_MS the connection is closed and the
//     session is reaped (same shape as a normal close).

import type { WebSocket } from "ws";
import type {
  JSONRPCMessage,
  MessageExtraInfo,
  RequestId,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { randomUUID } from "node:crypto";

export const PING_INTERVAL_MS = 30_000;
export const PING_TIMEOUT_MS = 90_000;

export interface WebSocketTransportOptions {
  /** Override the generated session id (useful for tests). */
  sessionId?: string;
  /** Override heartbeat ping interval; default 30s. */
  pingIntervalMs?: number;
  /** Override stale-connection timeout; default 90s. */
  pingTimeoutMs?: number;
}

/**
 * Per-WS-connection MCP transport. One instance per accepted socket.
 */
export class WebSocketServerTransport implements Transport {
  public sessionId?: string;
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: <T extends JSONRPCMessage>(
    message: T,
    extra?: MessageExtraInfo,
  ) => void;

  private ws: WebSocket;
  private pingTimer?: NodeJS.Timeout;
  private lastPongAt = Date.now();
  private pingIntervalMs: number;
  private pingTimeoutMs: number;
  private closed = false;

  constructor(ws: WebSocket, opts: WebSocketTransportOptions = {}) {
    this.ws = ws;
    this.sessionId = opts.sessionId ?? randomUUID();
    this.pingIntervalMs = opts.pingIntervalMs ?? PING_INTERVAL_MS;
    this.pingTimeoutMs = opts.pingTimeoutMs ?? PING_TIMEOUT_MS;
  }

  async start(): Promise<void> {
    this.ws.on("message", (data, isBinary) => {
      if (isBinary) {
        // MCP frames are JSON text. A binary frame is a client bug —
        // report it but keep the socket open: the SDK contract says
        // errors are non-fatal unless we explicitly close.
        this.onerror?.(new Error("WebSocket binary frame rejected (MCP expects text JSON)"));
        return;
      }
      let payload: unknown;
      try {
        payload = JSON.parse(typeof data === "string" ? data : data.toString("utf-8"));
      } catch (err) {
        this.onerror?.(
          err instanceof Error
            ? err
            : new Error(`WebSocket frame parse failed: ${String(err)}`),
        );
        return;
      }
      // Batched frame -> dispatch each entry; matches Streamable HTTP semantics.
      const items = Array.isArray(payload) ? payload : [payload];
      for (const item of items) {
        this.onmessage?.(item as JSONRPCMessage);
      }
    });

    this.ws.on("pong", () => {
      this.lastPongAt = Date.now();
    });

    this.ws.on("close", () => this.handleClose());
    this.ws.on("error", (err) => this.onerror?.(err));

    // Heartbeat: drives close-on-stale via lack of pongs.
    this.pingTimer = setInterval(() => {
      if (this.closed) return;
      const idleMs = Date.now() - this.lastPongAt;
      if (idleMs > this.pingTimeoutMs) {
        // 1001 = going away; matches the "stale connection" semantics
        // some collectors special-case.
        try {
          this.ws.close(1001, "heartbeat timeout");
        } catch {
          /* socket already gone */
        }
        return;
      }
      try {
        this.ws.ping();
      } catch {
        /* socket already gone */
      }
    }, this.pingIntervalMs).unref();
  }

  async send(
    message: JSONRPCMessage,
    _options?: { relatedRequestId?: RequestId },
  ): Promise<void> {
    if (this.closed) return;
    const text = JSON.stringify(message);
    await new Promise<void>((resolve, reject) => {
      this.ws.send(text, (err) => {
        if (err) reject(err);
        else resolve();
      });
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    try {
      // 1000 = normal closure.
      this.ws.close(1000, "server closing");
    } catch {
      /* already gone */
    }
    this.onclose?.();
  }

  private handleClose(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.onclose?.();
  }
}
