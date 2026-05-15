# Getting support

Thanks for using observability-mcp! Here's where to ask, and what to expect.

## Questions, ideas, "would you accept a PR that …"

→ **[GitHub Discussions](https://github.com/ThoTischner/observability-mcp/discussions)**

Best for open-ended questions, use-case discussions, connector ideas, design feedback. Lower friction than an issue — and usually faster, because other users help too.

## Bug reports & feature requests

→ **[GitHub Issues](https://github.com/ThoTischner/observability-mcp/issues)**

Use the templates so we can reproduce quickly. For bugs, please include:

- Version (`/api/info` exposes it, or check `package.json` / image tag)
- Deployment mode (npm, Docker, Helm chart, demo compose)
- What you expected, what you observed, minimal reproduction

## Security issues

→ **`ai-solutions-camp@email.de`** or a [private security advisory](https://github.com/ThoTischner/observability-mcp/security/advisories/new).

**Please don't open a public issue for security reports.** See [`SECURITY.md`](SECURITY.md) for the full disclosure process.

## Docs

Most setup questions are answered in the [docs](docs/) — quick links:

- [Configuration](docs/configuration.md) — `sources.yaml`, env vars, `${VAR}` substitution
- [Authentication & TLS](docs/auth-and-tls.md)
- [Connectors](docs/connectors.md) — write your own backend
- [Airgapped deployment](docs/airgapped-deployment.md)
- [Troubleshooting](docs/troubleshooting.md)

## Response times

This is a community-maintained open-source project. There's no SLA. Expect:

- **Discussions** — usually a reply within a few days
- **Issues** — triage within a week
- **Security reports** — best-effort acknowledgment within 48 hours

If something is urgent for a production use case, mention that in the issue / discussion so we can prioritize.

## Contributing back

If you fix something or write a new connector, please consider a PR. See [`CONTRIBUTING.md`](CONTRIBUTING.md) for the workflow.
