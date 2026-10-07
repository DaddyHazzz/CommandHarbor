# Open-Core Boundary

CommandHarbor uses an open-core architecture so the execution/control contracts can be inspected, tested, integrated, and extended without publishing private operational trust plumbing.

## Public open core

This repository contains:

- versioned device protocol and capability schemas;
- protocol fixtures and tests;
- the Windows ordinary execution core;
- Task Envelope and execution-strategy contracts;
- provider-neutral Worker Adapter interfaces;
- bounded System One-style decision-model interfaces;
- MCP-facing public interface types;
- public architecture and roadmap documentation;
- CI needed to validate this boundary independently.

## Private hosted / operational layer

The private internal repository retains:

- account, identity, OAuth/OIDC, session, and production authorization implementation;
- device enrollment and credential persistence;
- privileged founder/admin control paths;
- private host/service packaging and startup ownership;
- production/staging deployment configuration and resource identifiers;
- reviewer fixtures and review-window operational infrastructure;
- growth, billing, conversion, and private business operations;
- production audit/evidence archives and internal continuity material.

## Why this split exists

The goal is not security through obscurity. The public execution semantics should be reviewable.

The private boundary exists because operational credentials, production topology, privileged administration, deployment provenance, customer/reviewer operations, and business systems are not required to let developers inspect or extend the execution model.

## Compatibility rule

The hosted service should consume public contracts rather than silently fork them. Changes to public contracts should be versioned and tested in both the open core and the private integration layer before becoming authoritative.

## macOS

The macOS execution implementation is not included in the first public snapshot. Its ordinary automation code currently shares trust/host concerns that are being separated before publication. The architectural target is the same execution-core boundary used for Windows, without publishing credential or privileged host plumbing merely to claim symmetry.
