# Architecture

CommandHarbor's open core is organized around three layers.

## Execution substrate

The public execution core describes and implements bounded capabilities on user-owned machines. The versioned device protocol carries capability identity and operation messages without assuming a particular AI provider.

Enrollment, credential persistence, privileged host ownership, and production authorization are outside the public boundary.

### Execution authority handoff

Task-scoped execution must not rely on control-plane selection alone. A control plane that dispatches a task operation derives a narrow per-operation authorization grant and sends it with the operation. The grant binds the task subject, operation ID, capability, canonical argument hash, lease fencing generation, and expiry. The Windows execution core validates that grant immediately before invoking the capability and denies task-mode execution when the grant is missing, expired, or mismatched.

Ordinary non-task traffic remains explicit `session` authorization for compatibility. Capability profiles advertise `executionAuthorizationVersion` so a control plane can refuse task-scoped dispatch to an execution target that does not support the required local enforcement contract. The open core defines and enforces this handoff; hosted identity issuance and production transport authentication remain outside the public boundary.

## Arbitration control plane

The control-plane package defines context that should travel with autonomous work:

- Task Envelope;
- task-scoped capability allowlists;
- resource requests;
- aggregate and destination budgets;
- approval policy;
- independent success predicates;
- execution-strategy ordering;
- provider-neutral Worker Adapter interfaces;
- deterministic-first bounded-decision interfaces.

A model recommendation is never authorization.

## Hosted coordination

The hosted CommandHarbor service owns production identity, authorization, routing, device presence, resource coordination, durable evidence, and the future operator experience.

## Execution strategy

Prefer structured mechanisms before fragile interaction:

native/API -> CLI -> MCP -> WebMCP -> semantic/accessibility UI -> browser/DOM -> pixel control.

## External infrastructure

Provider/model routers, hosted agent runtimes, generic gateways, sandbox runtimes, and paid external capabilities fit beneath the arbitration layer.

CommandHarbor retains task identity, scoped authority, resource ownership, budgets, strategy selection, evidence, and independent verification.

See ROADMAP.md for sequencing and OPEN_CORE_BOUNDARY.md for the public/private split.
