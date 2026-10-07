# Coordination Contract Demo

This repository includes an executable deterministic fixture for the Phase 8 coordination contract:

- two heterogeneous worker descriptors on two logical machines;
- one shared repository plus one browser-session resource;
- an intentional resource conflict;
- lease release and reacquisition;
- deterministic selection of the strongest eligible execution strategy;
- a simulated first-worker failure followed by reroute to the second eligible worker;
- reservation-before-dispatch request/spend/tool-call budget enforcement;
- independent final-state verification;
- exact lease teardown after verification.

The fixture is runCoordinationContractDemo() in @commandharbor/control-plane.

## What this proves

It proves that the open-core control-plane contracts compose coherently and fail closed across arbitration, resource ownership, budget enforcement, reroute, and verification.

## What this does not prove

It is deliberately marked contractOnly: true.

It does not claim a live two-machine deployment, real provider traffic, production lease durability, real spend enforcement, or an independently observed outside-user workflow. Those require runtime integration against durable shared authority and a real fleet acceptance run.

The distinction is intentional: executable contract evidence is useful, but simulation is not production evidence.