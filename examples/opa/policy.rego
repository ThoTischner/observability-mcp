# Example Rego policy for the OMCP OPA engine.
#
# Mirrors the OMCP built-in DEFAULT_POLICY (viewer / operator / admin)
# and adds the redaction:bypass grant for admins. Wire it into OPA via
#
#   docker run --rm -p 8181:8181 \
#     -v $(pwd)/policy.rego:/policy.rego:ro \
#     openpolicyagent/opa:1.7.1 \
#     run --server --addr :8181 /policy.rego
#
# then point OMCP at it with:
#
#   OMCP_OPA_URL=http://opa:8181
#   OMCP_OPA_PACKAGE=observability/authz
#   OMCP_OPA_ROLES=admin,operator,viewer
#
# Two top-level rules are exposed:
#   - `allowed`  — boolean for the {input.roles, input.resource, input.action}
#                  decision the engine queries on every gate.
#   - `permissions` — list of {resource, action} for the Policy UI snapshot
#                     (queried when input.list = true).

package observability.authz

default allowed := false

# Helper: split into the per-role grant sets so the rule reads cleanly.

viewer_grants := [
    {"resource": "sources",  "action": "read"},
    {"resource": "services", "action": "read"},
    {"resource": "health",   "action": "read"},
    {"resource": "topology", "action": "read"},
    {"resource": "settings", "action": "read"},
    {"resource": "connectors","action": "read"},
    {"resource": "audit",    "action": "read"},
    {"resource": "catalog",  "action": "read"},
]

operator_grants := array.concat(viewer_grants, [
    {"resource": "sources",  "action": "write"},
    {"resource": "health",   "action": "write"},
    {"resource": "settings", "action": "write"},
])

admin_grants := array.concat(operator_grants, [
    {"resource": "sources",    "action": "delete"},
    {"resource": "connectors", "action": "write"},
    {"resource": "users",      "action": "read"},
    {"resource": "users",      "action": "write"},
    {"resource": "users",      "action": "delete"},
    {"resource": "redaction",  "action": "bypass"},
])

role_grants := {
    "viewer":   viewer_grants,
    "operator": operator_grants,
    "admin":    admin_grants,
}

# `allowed` is true when ANY role in input.roles grants the
# (resource, action) pair.
allowed if {
    some r in input.roles
    some grant in role_grants[r]
    grant.resource == input.resource
    grant.action == input.action
}

# The Policy UI / /api/me list-permissions path queries with
# input.list = true. OMCP's OpaPolicyEngine reads `.result.permissions`.
permissions := [grant |
    some r in input.roles
    some grant in role_grants[r]
] if input.list
