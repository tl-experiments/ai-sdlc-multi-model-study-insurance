# Security Review — Pass 1 (Opus-only)

> Produced by the security-reviewer subagent. Approved at HITL Gate 3.

## Summary
Pass 1 has a defensible POC-grade posture. PII encrypted at rest via per-record DEKs wrapped by env-supplied KEK. Authz enforced uniformly via `JwtAuthGuard` + `RolesGuard` on every controller route. PII reads/writes recorded in append-only audit log.

## Findings
| Severity | Category | Location | Issue | Recommendation |
|---|---|---|---|---|
| Minor | Defense-in-depth | `src/common/encryption.ts` | DEK wrap uses same IV as payload. | Separate random IV for the wrap step before prod. |
| Minor | Logging | `src/common/audit.interceptor.ts` | Audit insert failure swallowed. | Add Pino `error()` log. |
| Info | Config | `.env.example` | KEK_HEX defaulted to all zeros. | Add `start:dev` check that refuses to boot if KEK_HEX is zero. |

## Passing checks
- Every controller route guarded.
- JWT secret + KEK loaded from env, never hardcoded.
- Password hashing bcrypt cost factor 10.
- Helmet enabled in `main.ts`.
- Audit table no UPDATE/DELETE in code.
- Global error filter sanitizes responses.

**Verdict: Approved for Pass 1 acceptance.**
