# Architecture

CommandHarbor's open core is organized around three layers.

## Execution substrate

The public execution core describes and implements bounded capabilities on user-owned machines. The versioned device protocol carries capability identity and operation messages without assuming a particular AI provider.

Enrollment, credential persistence, privileged host ownership, and production authorization are outside the public boundary.

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
