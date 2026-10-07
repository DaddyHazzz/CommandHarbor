# CommandHarbor Roadmap

This roadmap separates **commercial evidence** from **architectural sequencing**. Phase 0 remains the market gate, but safe architecture work can proceed in parallel when it does not widen production authority or invent demand.

## Phase 0 — Get real users through the current product

CommandHarbor currently has more technical evidence than customer evidence.

The next commercial acceptance gate is a genuinely external user who:

1. installs or pairs a real machine;
2. connects through the Alpha surface;
3. completes a useful task;
4. has the result independently verified; and
5. later chooses to use CommandHarbor again.

Do not begin another broad reliability-hardening campaign unless outside use reproduces a real failure, a verified release blocker appears, or an explicit acceptance campaign requires it.

**Status:** active commercial priority.

## Phase 1 — First-class Task Envelope

Move from isolated tool invocations to durable task context.

A task envelope carries:

- task identity;
- initiating principal;
- originating worker;
- objective;
- allowed capabilities;
- requested resources;
- destinations;
- expiration;
- approval policy;
- aggregate and per-destination budgets;
- success predicates.

Every downstream operation should eventually inherit this context.

**Status:** contract implemented in `@commandharbor/control-plane`. Production integration is not yet authoritative.

## Phase 2 — Resource Arbiter and lease model

Generalize physical-input ownership into explicit resource ownership.

Initial resource classes:

- device;
- desktop/foreground input;
- browser/session;
- repository or filesystem path;
- process session;
- named application/window;
- network destination;
- paid capability.

A lease should answer:

- who owns the resource;
- for which task;
- until when;
- shared or exclusive;
- what authority accompanies it;
- what happens on expiry, failure, cancellation, or worker loss.

The goal is not merely locking. It is coordination among heterogeneous workers without accidental conflict.

The initial reference implementation acquires the full Task Envelope resource set atomically. Shared/shared holders may coexist; any exclusive holder conflicts. Leases snapshot task identity and authority, expire no later than the task envelope, and require exact lease/task identity for renewal or release. Explicit teardown reasons cover completion, cancellation, failure, worker loss, and manual release. Distributed authority will still require a durable store plus optimistic concurrency/fencing semantics; this in-memory layer deliberately does not pretend to solve consensus.

**Status:** in-memory deterministic contract/reference implementation complete; distributed/runtime authority integration pending.

## Phase 3 — Execution strategy as an explicit decision

CommandHarbor should select the strongest available mechanism before falling back to weaker interaction.

Current hierarchy:

1. native/API
2. CLI
3. MCP
4. WebMCP
5. semantic/accessibility UI
6. browser/DOM automation
7. pixel interaction

Selection should initially be deterministic and explainable. Typed bounded decision models can assist later when rules become unwieldy.

**Status:** deterministic hierarchy implemented; runtime integration pending.

## Phase 4 — Provider-neutral Worker Adapter contract

Do not build another general-purpose agent runtime.

Adapters should normalize workers such as hosted agents, coding agents, local models, deterministic processes, and sandbox runtimes behind a common lifecycle:

- describe capabilities;
- accept task;
- report state/progress;
- request resources or authority;
- produce evidence/result;
- cancel;
- fail.

Provider quirks belong inside adapters, not in CommandHarbor's task semantics.

**Status:** initial interface implemented; concrete adapters pending.

## Phase 5 — Independent Outcome Verification

Separate:

> the worker reported success

from:

> CommandHarbor independently observed success.

Examples:

- file exists / content hash;
- Git repository HEAD or diff state;
- process exit state and output;
- browser semantic state or exact URL;
- deployment endpoint state;
- structured capability result predicates.

Success predicates should be declared before execution whenever practical and become durable evidence.

**Status:** Task Envelope can already describe initial predicates; verifier engine pending.

## Phase 6 — Execution budgets

Budgets need task and lease semantics first.

Initial budgets should cover:

- maximum tool calls;
- maximum concurrent operations;
- maximum execution duration;
- network-request count;
- destination-specific request/concurrency limits;
- inference or external capability spend;
- human-approval consumption.

The important property is aggregate fleet enforcement, not asking every worker independently to behave.

**Status:** budget fields exist in Task Envelope; enforcement pending.

## Phase 7 — Deterministic-first Arbitration Engine

Inputs should eventually include:

- task type and objective;
- worker capabilities;
- current leases;
- machine/device state;
- available execution strategies;
- cost and latency;
- historical reliability;
- provider availability;
- policy;
- remaining budget.

Output should be typed:

- selected worker;
- machine;
- execution strategy;
- resource requirements;
- allowed capability set;
- fallback/escalation.

Decision hierarchy:

1. deterministic rule;
2. bounded typed decision model;
3. specialist/cheap reasoning;
4. frontier reasoning;
5. human escalation.

Probabilistic output never grants authority by itself.

**Status:** deterministic decision hierarchy and System One-style bounded-decision seam implemented; full arbiter pending.

## Phase 8 — Canonical multi-agent coordination demonstration

Build one demonstration that communicates the product boundary clearly.

Target scenario:

- two heterogeneous workers;
- two machines;
- one shared repository;
- one browser/session resource;
- an intentional conflict;
- one failed step requiring reroute;
- an enforced request or spend budget;
- independent verification of final state.

The operator should be able to see who did what, where, under what authority, and what evidence proves completion.

**Status:** not started; depends on leases, adapters, budgets, and verification.

## Phase 9 — Operator Control Plane

Once backend semantics are real, expose them clearly.

The operator surface should show:

- active tasks;
- workers;
- machines;
- resource leases;
- budgets;
- blocked actions;
- pending approvals;
- verification state;
- evidence;
- failure reasons.

It should answer **what is happening?** and **why?** before offering a wall of policy switches.

**Status:** future product layer.

## Phase 10 — Commercial Alpha for power users

Initial users should already feel coordination pain across multiple agents, machines, or development environments.

The value proposition is not primarily “secure your AI workforce.”

It is closer to:

> Let your authorized AI workers use your machines and tools together without fighting, duplicating work, exceeding bounds, or merely claiming they finished.

Security is part of why the control plane can be trusted, not the only noun on the homepage.

**Status:** external-user discovery is already active under Phase 0.

## Phase 11 — Governance and economic control

Only after repeated user value should CommandHarbor expand into:

- enterprise identity federation;
- team roles and policy administration;
- long-retention audit;
- compliance integrations;
- richer approval workflows;
- economic arbitration across models/tools/paid capabilities;
- paid MCP/API capability routing.

Do not pre-build a miniature identity provider, FinOps platform, and API gateway for hypothetical enterprise buyers.

**Status:** future.

## External infrastructure strategy

CommandHarbor should consume commodity layers rather than compete with them:

- **Clef / Clef-flash:** optional bounded-decision provider beneath deterministic policy.
- **Jev / System One:** compatibility shape, not a hard dependency.
- **AI/model routers:** subordinate model-selection primitive.
- **OpenAI/other hosted agents:** worker-adapter targets.
- **Generic MCP/API/A2A gateways:** lower-layer gateways behind the arbiter.
- **Sandbox runtimes such as OpenShell:** execution targets, not the control plane.
- **WebMCP:** preferred structured web execution when available.
- **paid capability protocols:** eventual economic resources governed by task budgets.

CommandHarbor's durable responsibility is the arbitration context above them: task identity, scoped authority, resources, budgets, routing, and independently verified outcomes.
