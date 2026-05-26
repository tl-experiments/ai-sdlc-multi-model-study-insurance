# ADR-003: Role Masking by APPI Tier

**Status:** Accepted  
**Date:** 2024-01-01  
**Deciders:** Platform Architecture Team  
**Regulated under:** APPI (個人情報保護法) / JFSA (金融庁)  
**Track:** A (enforced) — Track B adds Postgres RLS for column-level enforcement

---

## Context

The Claims Processing Platform serves five distinct roles — `agent`, `adjuster`, `manager`, `auditor`, and `siu_referrer` — each with a legitimately different need to see personal information about claimants, reporters, and witnesses. The same `Claim` database row must produce different JSON responses depending on who is asking.

Two regulatory frameworks govern what each role may see:

### APPI PII Tiers

Japan's Act on the Protection of Personal Information (APPI) distinguishes two tiers of sensitivity:

**Standard Personal Information (一般個人情報)** — `reporter_name`, the cleartext copies of `reporter_phone` and `reporter_email`, and `loss_location_detail`. These are operationally necessary for day-to-day claims handling. Storing them cleartext and restricting their visibility at response time is a proportionate balance between operational utility and data minimisation.

**Special-Care Personal Information (要配慮個人情報) — APPI Article 17** — `insured_government_id_ct`, `bank_account_for_payout_ct`, `injury_details_ct`, `reporter_phone_ct`, `reporter_email_ct`, and `witness_phone_ct`. These fields are encrypted at rest (see ADR-001) and must never appear in normal API responses under any role. They are surfaced exclusively via the explicit APPI Article 28 data-subject export endpoint.

### Operational Access Constraints

Beyond APPI tiering, the business has additional access constraints:

- **Claim ownership** — an adjuster should see cleartext standard PII only for claims they are assigned to. An adjuster viewing a claim assigned to a colleague sees the same field masked as a manager would.
- **Role-specific read scope** — agents can only read claims they originated (within 24 hours of FNOL); SIU referrers can only read claims they have flagged; managers can only read claims in their reports' pool.
- **Auditor access** — the `auditor` role has read access to all claims but sees standard PII masked (they are not operational claims handlers). The `auditor` can access full PII only via the data-subject export.
- **Address granularity** — `loss_location_detail` (street-level) is visible to adjusters and managers. Non-adjuster roles (agent, auditor, siu_referrer) see only the prefecture (`loss_location_prefecture`).

### Problem Statement

Without a single, authoritative masking function, PII masking logic scatters across controllers, services, and serialisers. Each new endpoint risks accidentally exposing a field. Adding a new sensitive field requires auditing every response path. Regulatory examination of the codebase becomes impractical.

We need a masking design that:

1. Is implemented in exactly one place, making it auditable.
2. Is driven by the APPI tier of each field, not ad-hoc per-controller logic.
3. Accounts for claim ownership (assigned adjuster gets cleartext; others get masked).
4. Returns a structurally complete response object — masked fields are present but redacted, not silently omitted, so API consumers have a stable contract.
5. Is tested exhaustively: every role × every field combination.

---

## Decision

### Single masking function: `maskByAppiTier()`

All masking logic is implemented in `src/common/pii-mask.util.ts` as a single exported function:

```typescript
export function maskByAppiTier(
  claim: ClaimWithRelations,
  callerRole: UserRole,
  isAssignedAdjuster: boolean,
): MaskedClaim
```

The function:
1. Receives the full claim record (as fetched from Prisma, with all relations).
2. Receives the caller's `UserRole` and a boolean indicating whether the caller is the adjuster currently assigned to this claim.
3. Returns a `MaskedClaim` object — a new object with identical shape but with sensitive fields replaced by redaction markers.

No controller or service applies masking logic directly. Every `GET /claims/:id` response and every claim included in a list response passes through `maskByAppiTier()` before serialisation.

### Field visibility matrix

| Field | APPI Tier | `agent` | `adjuster` (assigned) | `adjuster` (not assigned) | `manager` | `auditor` | `siu_referrer` |
|---|---|---|---|---|---|---|---|
| `reporter_name` | Standard PII | `[MASKED]` | cleartext | `[MASKED]` | cleartext | `[MASKED]` | `[MASKED]` |
| `reporter_phone` (cleartext) | Standard PII | `[MASKED]` | cleartext | `[MASKED]` | cleartext | `[MASKED]` | `[MASKED]` |
| `reporter_email` (cleartext) | Standard PII | `[MASKED]` | cleartext | `[MASKED]` | cleartext | `[MASKED]` | `[MASKED]` |
| `loss_location_detail` | Standard PII | prefecture only | cleartext | prefecture only | cleartext | prefecture only | prefecture only |
| `loss_location_prefecture` | Not PII | visible | visible | visible | visible | visible | visible |
| `policy_number` | Sensitive | `[MASKED]` | cleartext | `[MASKED]` | cleartext | cleartext | `[MASKED]` |
| `reporter_phone_ct` | Art. 17 Special-care | never | never | never | never | never | never |
| `reporter_email_ct` | Art. 17 Special-care | never | never | never | never | never | never |
| `insured_government_id_ct` | Art. 17 Special-care | never | never | never | never | never | never |
| `bank_account_for_payout_ct` | Art. 17 Special-care | never | never | never | never | never | never |
| `injury_details_ct` | Art. 17 Special-care | never | never | never | never | never | never |

> **"never"** for `_ct` columns means the field is stripped from the response entirely (not redacted with a marker). The encrypted blob is never transmitted. These fields are only accessible via `GET /claims/:id/data-subject-export`, which is restricted to `auditor` and `manager` roles and calls `appi.service.ts` directly.

> **"prefecture only"** for `loss_location_detail` means the response includes `loss_location_prefecture` but `loss_location_detail` is replaced with `"[ADDRESS DETAIL RESTRICTED]"`.

### Redaction markers

Masked standard PII fields use string redaction markers rather than `null` or field omission. This keeps the API contract stable — consumers always receive the field, just with a non-data value.

| Situation | Marker |
|---|---|
| Name, phone, email masked | `"[MASKED]"` |
| Policy number masked | `"[MASKED]"` |
| Address detail restricted | `"[ADDRESS DETAIL RESTRICTED]"` |
| Special-care `_ct` field | field omitted from response entirely |

The choice of a string marker over `null` is deliberate: `null` could be confused with a legitimately absent optional field. The `[MASKED]` string is unambiguous and searchable in logs.

### Interceptor vs. service-layer masking

Masking is applied in the **service layer**, not a controller interceptor. This is a deliberate departure from the ADR-001 framing of "controller-level `MaskByAppiInterceptor`". The rationale:

- The masking decision depends on `isAssignedAdjuster`, which requires the claim record to already be fetched.
- Services are the natural location for business rules that depend on the fetched entity.
- Interceptors see only the serialised response; applying masking before serialisation avoids any risk of accidental leakage through custom serialisers or DTOs.

`claims.service.ts#findOne()` calls `maskByAppiTier()` before returning the result to the controller. `claims.service.ts#findAll()` calls `maskByAppiTier()` on each result in the list.

### `isAssignedAdjuster` determination

The `isAssignedAdjuster` flag is computed in the service:

```typescript
const isAssignedAdjuster =
  caller.role === UserRole.adjuster &&
  claim.assigned_adjuster_id === caller.id;
```

A manager who happens to have the same `id` as the assigned adjuster is not treated as `isAssignedAdjuster` — the role check is strict. An adjuster who is assigned gets cleartext; any other adjuster gets masked.

### Data-subject export bypass

`GET /claims/:id/data-subject-export` does **not** call `maskByAppiTier()`. It calls `appi.service.ts#exportDataSubject()`, which:

1. Fetches the full claim record.
2. Calls `decrypt()` from `encryption.ts` on all `_ct` fields.
3. Returns a structured APPI Article 28 disclosure document containing all PII including special-care fields.

This is the only code path where `_ct` columns are decrypted and returned. It is protected by `@Roles(UserRole.auditor, UserRole.manager)` and emits an `AuditEvent` with action `claim.data_subject.exported`.

### Single source of truth

`pii-mask.util.ts` is the only file that knows which fields belong to which APPI tier and which roles may see them cleartext. Adding a new sensitive field to the `Claim` model requires exactly two changes:

1. Add the field to the Prisma schema.
2. Add one entry to the masking table in `pii-mask.util.ts`.

No controller, interceptor, or DTO needs to be updated for the masking to take effect across all endpoints.

---

## Consequences

### Positive

- **Single auditable source of truth.** Every PII visibility decision is in one 100-line file. A regulatory examiner or security auditor can review the full masking policy without reading every controller.
- **Stable API contract.** Consumers receive every field on every response; masked fields have a predictable string marker rather than absent keys. No brittle `undefined` checks in frontend code.
- **Claim-ownership-aware.** The `isAssignedAdjuster` flag ensures the acceptance criterion — "adjuster JWT returns `reporter_phone` cleartext only if the adjuster is the assigned one" — is satisfied by the masking function, not scattered guard clauses.
- **APPI Article 17 fields never leak.** `_ct` columns are stripped before the response object is constructed. There is no code path through which a `_ct` blob reaches a normal API response.
- **Auditor access preserved for export.** The `auditor` role can access full PII via the explicit data-subject export endpoint; standard API responses are masked for auditors just like other non-operational roles.
- **Prefecture-level granularity for address.** Non-adjuster roles receive `loss_location_prefecture` (the 都道府県), which is sufficient for routing and statistics, without exposing the street-level address that could enable physical targeting.

### Negative / Accepted trade-offs

- **Service-layer coupling.** Masking in the service layer means the service must always receive the caller's identity. This is already required for ownership checks (`isAssignedAdjuster`), so the coupling is not new, but it means pure service unit tests must supply a mock caller.
- **Response shape diverges from Prisma model.** `MaskedClaim` is a distinct TypeScript type from the Prisma `Claim` type. This requires a typed mapping layer; the benefit is compile-time assurance that no new `_ct` field is accidentally included in a `MaskedClaim`.
- **No database-layer enforcement in Track A.** A database query executed outside the application (e.g. by a DBA running ad-hoc SQL) bypasses `maskByAppiTier()`. Mitigated by ADR-001 (special-care fields are encrypted) and deferred Postgres RLS (Track B).
- **Masking is not pagination-aware.** `findAll()` applies `maskByAppiTier()` to each result individually, which is correct but means N claims → N masking function calls. At high volumes this is negligible CPU; noted for completeness.

---

## Alternatives Considered

### Option 1: Per-controller `ClassSerializerInterceptor` with `@Exclude()` / `@Expose()` decorators

Rejected. NestJS `ClassSerializerInterceptor` with `@Exclude()` operates on fixed class properties, not on runtime conditions (caller role, claim ownership). Encoding role-conditional visibility in decorators requires multiple response DTO classes per role — a combinatorial explosion for five roles × fifteen fields × two ownership states. Maintenance becomes untenable.

### Option 2: Multiple response DTOs (one per role)

Rejected for the same reason as Option 1. Five DTO classes (`ClaimResponseAgent`, `ClaimResponseAdjuster`, etc.) that must all be updated when the `Claim` schema changes. The masking logic is still scattered; it is just scattered across class definitions rather than controller methods.

### Option 3: GraphQL with field-level resolvers and directives

Out of scope for Track A. The platform uses a REST API. A GraphQL layer with `@auth` directives on field resolvers would be a natural fit for role-conditional field visibility, but it introduces a dependency not in the approved tech stack. Noted as a Track B option if the API surface expands significantly.

### Option 4: Postgres row-level security + column-level permissions

Considered for Track B. Postgres supports column-level `GRANT` statements and RLS policies that can restrict which application roles see which columns. This would enforce masking at the database layer, independent of application code. However, it requires multiple Postgres roles (one per application role), which complicates the Prisma connection model and migrations. Track B will evaluate this as a defence-in-depth layer on top of application-layer masking, not as a replacement.

### Option 5: Response interceptor with access to caller identity

Rejected. An NestJS interceptor runs after the controller and before serialisation. It can access `ExecutionContext` to retrieve the caller, but it cannot easily access the claim's `assigned_adjuster_id` without re-querying the database (the response is already a serialised object at that point, not the Prisma record). Moving the masking logic to the service layer — where the Prisma record is available — avoids this problem cleanly.

---

## Test Matrix

The following combinations are covered by `test/claims-workbench.e2e.spec.ts` and `test/claims-fnol.e2e.spec.ts`:

| Scenario | Assertion |
|---|---|
| Assigned adjuster reads own claim | `reporter_phone` cleartext; `reporter_name` cleartext; `loss_location_detail` cleartext |
| Non-assigned adjuster reads another adjuster's claim | `reporter_phone` = `"[MASKED]"`; `reporter_name` = `"[MASKED]"` |
| Manager reads claim in their pool | `reporter_phone` cleartext; `policy_number` cleartext |
| Auditor reads any claim | `reporter_name` = `"[MASKED]"`; `loss_location_detail` = `"[ADDRESS DETAIL RESTRICTED]"` |
| Agent reads own intake claim (within 24h) | `reporter_phone` = `"[MASKED]"`; `policy_number` = `"[MASKED]"` |
| Any role reads claim | `reporter_phone_ct` key absent from response |
| Any role reads claim | `insured_government_id_ct` key absent from response |
| Auditor calls data-subject export | `insured_government_id` present as decrypted plaintext |
| Manager calls data-subject export | `bank_account_for_payout` present as decrypted plaintext |
| Adjuster calls data-subject export | HTTP 403 |

---

## Compliance Traceability

| APPI requirement | How this ADR satisfies it |
|---|---|
| Art. 16 — Purpose limitation (利用目的の制限) | Standard PII masked for roles with no operational need; role matrix enforces minimum necessary access |
| Art. 17 — Special-care personal information (要配慮個人情報) | `_ct` fields never returned in normal API; only via explicit Art. 28 export |
| Art. 20 — Security management measures (安全管理措置) | Single masking function is the auditable control; no scattered masking logic |
| Art. 28 — Right to disclosure (開示請求) | Data-subject export endpoint bypasses masking and decrypts `_ct` fields; returns complete PII inventory |
| Acceptance criterion §7 | `maskByAppiTier()` enforces assigned-adjuster cleartext vs. masked distinction |

---

## Related ADRs

- **ADR-001** — PII Encryption (`_ct` columns encrypted at rest; this ADR governs their visibility at response time)
- **ADR-002** — Audit log immutability (the `auditor` role read path uses `maskByAppiTier()` for standard API responses; data-subject export is a separate path)
- **ADR-005** — Reserve approval tiers (reserve amounts are financial data; `manager` and `adjuster` visibility follows the same role-based principle)

---

## Implementation Reference

| File | Role |
|---|---|
| `src/common/pii-mask.util.ts` | `maskByAppiTier(claim, callerRole, isAssignedAdjuster)` — single source of truth for field visibility |
| `src/claims/claims.service.ts` | Calls `maskByAppiTier()` in `findOne()` and `findAll()` before returning to controller |
| `src/appi/appi.service.ts` | `exportDataSubject()` — the only path that decrypts `_ct` fields; does not call `maskByAppiTier()` |
| `src/common/encryption.ts` | `decrypt()` called by `appi.service.ts` only; never called by masking util |
| `test/claims-workbench.e2e.spec.ts` | Role × field masking test matrix |
| `docs/adr/003-role-masking-by-appi-tier.md` | This document |

---

## Track B Follow-On Actions

1. **Postgres column-level grants** — add `REVOKE SELECT (reporter_phone_ct, reporter_email_ct, insured_government_id_ct, bank_account_for_payout_ct, injury_details_ct, injury_details_ct) ON claims FROM app_role;` and grant SELECT on those columns only to a dedicated `appi_export_role` used by `appi.service.ts`. This enforces `_ct` column access at the database layer, independent of application code.
2. **RLS policy for claim ownership** — a Postgres RLS policy can enforce adjuster-to-claim assignment at the database layer, providing a second line of defence beyond the `isAssignedAdjuster` check in the service.
3. **Structured masking audit** — extend `AuditInterceptor` to record which fields were masked (not their values) in the audit event payload when a claim is read. Enables detection of systematic access probing by a single actor.
4. **Automated masking contract tests** — add a `pii-mask.contract.spec.ts` that enumerates all fields in the Prisma `Claim` type via reflection and asserts that every field is explicitly classified in `pii-mask.util.ts`. Prevents new fields from silently inheriting "visible to all" behaviour.
5. **Japanese UI field labels** — when Japanese-language UI is added in Track B, `loss_location_prefecture` should display the canonical 都道府県 name; the prefecture validation list in `format-yen.ts` provides the mapping.