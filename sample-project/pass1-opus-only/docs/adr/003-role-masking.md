# ADR-003: Role-based PII Masking via Service+Util

**Status:** Accepted · **Pass:** 1 (Opus-only)

## Context
Same endpoint returns different field sets per role. Need one source of truth so the rule cannot be bypassed.

## Decision
Service layer returns the un-masked view. Controller calls `maskEmployee(view, viewer, managerChain)` before returning. `maskEmployee` is the single function that decides what to redact. Tests assert per role.

| Viewer | Sees |
|---|---|
| admin | full record |
| self | full record |
| manager (in subject's reports_to chain) | phone + address visible, other PII masked |
| auditor / any other | all PII masked |

## Consequences
- **+** Adding a sensitive field means changing one file (`mask.util.ts`). Easy to test exhaustively.
- **−** Service holds plaintext briefly — care needed not to log it.
