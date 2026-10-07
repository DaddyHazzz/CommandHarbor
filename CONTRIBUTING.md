# Contributing

Thanks for helping improve CommandHarbor.

## Before opening a change

1. Keep the open-core boundary intact. Do not add production credentials, deployment identifiers, private operational evidence, or founder/admin infrastructure.
2. Prefer small changes with focused tests.
3. Keep deterministic policy ahead of probabilistic decision-making when a rule can decide reliably.
4. Treat execution authority as explicit. New capabilities should declare their effect and should not silently widen existing authority.
5. Preserve provider neutrality in protocol and control-plane contracts.

## Development

Use Node.js 24.

```bash
npm ci
npm run check
```

## Pull requests

Explain the behavior being changed, why it belongs in the open core, tests added or updated, security or authority implications, and compatibility impact.

## Security reports

Do not disclose an unpatched vulnerability in a public issue. Follow SECURITY.md.
