// Reusable hook-fire wrappers around the MCP SDK's tool / resource /
// prompt callbacks.
//
// Each wrapper fires the matching `*_pre_*` hook before the original
// handler runs and `*_post_*` after it returns. Hooks can:
//   - deny the call (allow:false → caller sees a structured error)
//   - mutate the payload before dispatch (args / uri / arguments)
//   - mutate the result before it reaches the caller (contents /
//     messages / tool result)
//
// When no hooks are registered (the default in the OSS demo) the
// wrappers are thin pass-throughs.
//
// The wrappers are pure — they take the HookRegistry + a ctx object
// and a handler, and return the wrapped handler. They never touch
// the McpServer SDK directly, so they're trivially unit-testable.

import type { HookContext, HookRegistry, HookResult } from "./hooks.js";

export interface HookCtxBase {
  /** Principal sub identifier from the caller's RequestContext. */
  principal: string;
  /** Tenant the caller is acting under. */
  tenant: string;
  /** Tool / resource / prompt target identifier. */
  target: string;
}

type ToolHandler = (args: unknown, extra: unknown) => Promise<unknown> | unknown;
type ResourceHandler = (uri: URL | string, extra?: unknown) => Promise<unknown> | unknown;
type PromptHandler = (args: unknown, extra?: unknown) => Promise<unknown> | unknown;

/** Shape an MCP tool dispatch returns on a hook denial. */
function deniedToolResult(reason?: string): unknown {
  return {
    content: [{ type: "text", text: reason ?? "denied by plugin hook" }],
    isError: true,
  };
}

/** Shape an MCP resource read returns on a hook denial. */
function deniedResourceResult(uri: string, reason?: string): unknown {
  return {
    contents: [
      { uri, mimeType: "text/plain", text: reason ?? "denied by plugin hook" },
    ],
    isError: true,
  };
}

/** Shape an MCP prompt fetch returns on a hook denial. */
function deniedPromptResult(reason?: string): unknown {
  return {
    description: reason ?? "denied by plugin hook",
    messages: [],
    isError: true,
  };
}

/**
 * Wrap a tool handler with `tool_pre_invoke` + `tool_post_invoke`
 * hooks. Existing wire-up in index.ts is inlined; extracting it here
 * for parity with the new resource + prompt wrappers and so tests
 * can exercise the path without spinning up the full server.
 */
export function wrapToolHandler(
  registry: HookRegistry,
  ctx: HookCtxBase,
  handler: ToolHandler,
): ToolHandler {
  return async (args, extra) => {
    const pre = await registry.fire(
      "tool_pre_invoke",
      { ...ctx, kind: "tool_pre_invoke" as const } satisfies HookContext,
      { args },
    );
    if (!pre.allow) return deniedToolResult(pre.reason);
    const effectiveArgs = (pre.payload as { args?: unknown } | undefined)?.args ?? args;
    const result = await handler(effectiveArgs, extra);
    const post = await registry.fire(
      "tool_post_invoke",
      { ...ctx, kind: "tool_post_invoke" as const } satisfies HookContext,
      { args: effectiveArgs, result },
    );
    if (!post.allow) return deniedToolResult(post.reason);
    return (post.payload as { result?: unknown } | undefined)?.result ?? result;
  };
}

/**
 * Wrap a resource readCallback with `resource_pre_fetch` +
 * `resource_post_fetch` hooks.
 *
 * Pre-fetch sees `{uri}`; the payload's `uri` can be mutated (e.g. a
 * canonicalising plugin) and the override flows into the original
 * handler. Post-fetch sees `{uri, contents}`; the post-payload's
 * `contents` (if set) replaces the response.
 */
export function wrapResourceHandler(
  registry: HookRegistry,
  ctx: HookCtxBase,
  handler: ResourceHandler,
): ResourceHandler {
  return async (uri, extra) => {
    const uriStr = uri instanceof URL ? uri.toString() : String(uri);
    const pre = await registry.fire(
      "resource_pre_fetch",
      { ...ctx, kind: "resource_pre_fetch" as const } satisfies HookContext,
      { uri: uriStr },
    );
    if (!pre.allow) return deniedResourceResult(uriStr, pre.reason);
    const effectiveUri = (pre.payload as { uri?: string } | undefined)?.uri ?? uriStr;
    // Preserve URL vs string typing the SDK expects.
    const forwardedUri = uri instanceof URL && effectiveUri !== uriStr ? new URL(effectiveUri) : (uri instanceof URL ? uri : effectiveUri);
    const result = await handler(forwardedUri, extra);
    const post = await registry.fire(
      "resource_post_fetch",
      { ...ctx, kind: "resource_post_fetch" as const } satisfies HookContext,
      { uri: effectiveUri, contents: (result as { contents?: unknown } | undefined)?.contents },
    );
    if (!post.allow) return deniedResourceResult(effectiveUri, post.reason);
    const overrideContents = (post.payload as { contents?: unknown } | undefined)?.contents;
    if (overrideContents !== undefined && result && typeof result === "object") {
      return { ...(result as Record<string, unknown>), contents: overrideContents };
    }
    return result;
  };
}

/**
 * Wrap a prompt callback with `prompt_pre_fetch` + `prompt_post_fetch`
 * hooks.
 *
 * Pre-fetch sees `{name, arguments}`; the override flows in. Post-fetch
 * sees `{name, arguments, messages}`; the post-payload's `messages`
 * (if set) replaces the response messages.
 */
export function wrapPromptHandler(
  registry: HookRegistry,
  ctx: HookCtxBase,
  handler: PromptHandler,
): PromptHandler {
  return async (args, extra) => {
    const pre = await registry.fire(
      "prompt_pre_fetch",
      { ...ctx, kind: "prompt_pre_fetch" as const } satisfies HookContext,
      { name: ctx.target, arguments: args },
    );
    if (!pre.allow) return deniedPromptResult(pre.reason);
    const effectiveArgs = (pre.payload as { arguments?: unknown } | undefined)?.arguments ?? args;
    const result = await handler(effectiveArgs, extra);
    const post = await registry.fire(
      "prompt_post_fetch",
      { ...ctx, kind: "prompt_post_fetch" as const } satisfies HookContext,
      { name: ctx.target, arguments: effectiveArgs, messages: (result as { messages?: unknown } | undefined)?.messages },
    );
    if (!post.allow) return deniedPromptResult(post.reason);
    const overrideMessages = (post.payload as { messages?: unknown } | undefined)?.messages;
    if (overrideMessages !== undefined && result && typeof result === "object") {
      return { ...(result as Record<string, unknown>), messages: overrideMessages };
    }
    return result;
  };
}
