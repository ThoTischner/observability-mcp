// Example tool_post_invoke hook — masks emails + IPv4 addresses in
// the tool result before it reaches the LLM. Intentionally minimal:
// real deployments wire a richer redaction policy via OMCP_REDACTION,
// this is just a demonstration of the plugin hook contract.
//
// Hook contract:
//   (ctx, payload) => { allow: boolean, payload?: object, reason?: string }
//
// payload for tool_post_invoke:
//   { args: <original tool args>, result: <CallToolResult-shaped> }

const EMAIL_RE = /[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g;
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g;

function maskString(s) {
  return s.replace(EMAIL_RE, "[redacted-email]").replace(IPV4_RE, "[redacted-ip]");
}

function maskValue(v) {
  if (typeof v === "string") return maskString(v);
  if (Array.isArray(v)) return v.map(maskValue);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = maskValue(val);
    return out;
  }
  return v;
}

export default async function (ctx, payload) {
  const result = payload?.result;
  if (!result) return { allow: true };
  return { allow: true, payload: { ...payload, result: maskValue(result) } };
}
