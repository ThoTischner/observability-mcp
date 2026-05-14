// Strip CR/LF/control chars from values that flow into log output so a
// malicious source config can't inject forged log lines, and cap length so
// pathological inputs don't blow up the log volume.
export function sanitizeForLog(value: unknown): string {
  return String(value).replace(/[\r\n\x00-\x1f\x7f]/g, "_").slice(0, 500);
}
