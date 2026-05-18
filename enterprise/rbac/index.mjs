// Public surface of the FSL RBAC module (FSL-1.1-Apache-2.0).
export { evaluate, rolesFor } from "./policy.mjs";
export { enforce, check, RbacDeniedError } from "./enforce.mjs";
