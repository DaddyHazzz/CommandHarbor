# CommandHarbor

**Provider-neutral execution control plane for authorized AI work across agents, machines, tools, and providers.**

CommandHarbor is being built around a simple boundary: AI workers may be replaceable, but execution authority, resource ownership, budgets, routing, and independent evidence should not be.

The open core contains the protocol and execution primitives that make that boundary inspectable and extensible. The hosted CommandHarbor service remains the identity, routing, coordination, and production operations layer.

## What is open here

- **Device protocol** — versioned messages, capability profiles, operation identity, and test fixtures.
- **Control-plane contracts** — Task Envelope, deterministic execution-strategy selection, provider-neutral Worker Adapter types, and bounded decision-model interfaces.
- **Windows execution core** — ordinary filesystem, document, process, retrieval, visual, window, accessibility/UI Automation, and desktop-control capability implementations.
- **MCP-facing interfaces** — the public read-only tool inventory and backend/task contracts without production identity or dispatch plumbing.
- **Tests and CI** — the public boundary is intended to compile and test independently of the private hosted service.

## What is not in this repository

This repository deliberately excludes production identity/account services, device enrollment and credential persistence, founder/admin control, reviewer fixtures, billing/growth systems, production deployment configuration, private operational evidence, and production/staging identifiers.

See [docs/OPEN_CORE_BOUNDARY.md](docs/OPEN_CORE_BOUNDARY.md) for the exact split.

## Architecture direction

CommandHarbor's intended decision path is:

```text
human / upstream worker intent
          |
      Task Envelope
          |
        Arbiter
  worker / machine / strategy
          |
    Resource leases
          |
 scoped capability execution
          |
 independent verification
          |
        evidence
```

Execution should prefer the least fragile structured mechanism available:

```text
native/API -> CLI -> MCP -> WebMCP -> semantic UI -> browser/DOM -> pixels
```

Decision-making should use the least probabilistic mechanism that can decide reliably:

```text
deterministic policy -> bounded typed model -> specialist reasoning -> frontier reasoning -> human escalation
```

Probabilistic output is advisory. It does not grant authority by itself.

## Roadmap

The detailed roadmap is in [docs/ROADMAP.md](docs/ROADMAP.md). The commercial Gate 0 remains real outside-user evidence, while safe architectural work proceeds in parallel.

Current open-core progress includes:

- Task Envelope contract: **implemented**
- execution-strategy hierarchy: **implemented**
- provider-neutral Worker Adapter interface: **implemented**
- System One-style bounded decision seam: **implemented, advisory**
- generalized resource arbiter: **implemented in open-core contract; runtime integration pending**
- independent outcome verification: **implemented in open-core contract; concrete probes/runtime integration pending**
- task-level budget reservation ledger: **implemented in open-core contract; distributed/fleet enforcement pending**
- fleet-level arbitration engine: **after durable shared authority integration**

## Development

Requirements:

- Node.js 24
- npm

```bash
npm ci
npm run check
```

## Security

Please read [SECURITY.md](SECURITY.md). Do not open a public issue for an unpatched vulnerability.

## License

The open-source code in this repository is licensed under the [Apache License 2.0](LICENSE).

## Hosted service

The production service and product information are at https://commandharbor.com.
