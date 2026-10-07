# Security Policy

Please report security vulnerabilities privately through GitHub Security Advisories or by emailing security@commandharbor.com. Do not open a public issue for an unpatched vulnerability.

CommandHarbor uses explicit authorization boundaries and treats execution authority as a security-sensitive capability. Reports that demonstrate cross-account access, authorization bypass, credential exposure, or unintended execution are especially valuable.

Task-scoped operations are expected to carry a narrow execution authorization grant that is checked again at the execution layer. Integrations should not treat worker selection, routing, or model output as authorization.

Protected-path checks resolve and validate filesystem paths before an operation, but ordinary filesystem APIs do not make path validation and the subsequent file mutation one indivisible transaction. A hostile concurrent actor able to replace path components between those steps can create time-of-check/time-of-use risk. Deployments that require protection against a same-machine adversary should add OS-level isolation or stronger filesystem primitives rather than relying on path validation alone.
