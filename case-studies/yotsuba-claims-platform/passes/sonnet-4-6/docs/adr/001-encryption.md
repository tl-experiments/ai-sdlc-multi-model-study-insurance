# ADR-001: PII Encryption — AES-256-GCM, APPI-Tier-Aware

**Status:** Accepted  
**Date:** 2024-01-01  
**Deciders:** Platform Architecture Team  
**Regulated under:** APPI (個人情報保護法) / JFSA (金融庁)  
**Track:** A (enforced) — Track B adds KMS integration

---

## Context

The Claims Processing Platform handles personal information under Japan's Act on the Protection of Personal Information (APPI / 個人情報保護法). APPI distinguishes between two tiers of sensitivity:

### Standard Personal Information (一般個人情報)

Fields such as `reporter_name`, `reporter_phone`, `reporter_email`, and `loss_location_detail` constitute standard PII. These are necessary for day-to-day claims operations and are routinely accessed by adjusters and managers. Storing them cleartext and masking them at response time is proportionate and operationally practical.

### Special-Care Personal Information (要配慮個人情報) — APPI Article 17

APPI Article 17 creates a stricter category for information whose exposure carries heightened harm risk: medical / injury information, government-issued identification numbers, and financial account details. The platform holds three such categories:

| Field | APPI Art. 17 category | Prisma column |
|---|---|---|
| `insured_government_id` | Government-issued ID (個人番号 / マイナンバー) | `insured_government_id_ct` |
| `bank_account_for_payout` | Financial account (銀行口座情報) | `bank_account_for_payout_ct` |
| `injury_details` | Medical / injury information (傷病情報) | `injury_details_ct` |
| `reporter_phone` | Contact information (連絡先電話番号) | `reporter_phone_ct` |
| `reporter_email` | Contact information (連絡先メール) | `reporter_email_ct` |
| `witness_phone` | Contact information (証人連絡先) | `witness_phone_ct` |

For special-care fields, cleartext storage is not acceptable even with response-time masking. A database breach would expose them unconditionally. Encryption at rest is required.

### Problem Statement

We need an encryption scheme for `_ct` (ciphertext) columns that:

1. Protects special-care PII from database-level exposure.
2. Operates without an external KMS in the Track A POC (but is designed so KMS can be swapped in as a 1-for-1 replacement in Track B).
3. Produces unique ciphertexts per record (prevents frequency analysis across identical values).
4. Is implemented in a single file (`src/common/encryption.ts`) so every module that writes or reads PII uses the same code path.
5. Satisfies the APPI principle of *minimum necessary use* by making special-care fields inaccessible in normal API responses — they are only surfaced via the explicit APPI Article 28 data-subject export.

---

## Decision

### Encryption scheme: AES-256-GCM with per-record DEK, env-supplied KEK

```
  Plaintext value
       │
       ▼
  [crypto.randomBytes(32)]  ← per-record Data Encryption Key (DEK)
       │
       ▼
  AES-256-GCM encrypt(plaintext, DEK, IV=randomBytes(12))
       │
       ▼
  [IV (12 bytes) ‖ AuthTag (16 bytes) ‖ Ciphertext]
       │
       ▼
  [ENCRYPTION_KEK (env, 32-byte hex)] wraps DEK
  AES-256-GCM encrypt(DEK, KEK, IV₂=randomBytes(12))
       │
       ▼
  [IV₂ (12 bytes) ‖ AuthTag₂ (16 bytes) ‖ WrappedDEK]
       │
       ▼
  Stored blob = [WrappedDEK envelope] ‖ [Data envelope]
  Postgres column type: Bytes  (@db.ByteA)
```

The outer KEK envelope means that rotating the KEK requires re-wrapping the per-record DEK blobs — not re-encrypting all data. This is the standard pattern for envelope encryption (AWS KMS, Google Cloud KMS, Azure Key Vault all implement this shape); swapping `ENCRYPTION_KEK` for a real KMS call in Track B is a clean seam.

### Key management (Track A POC)

- `ENCRYPTION_KEK` is a 32-byte (64 hex character) value supplied via environment variable.
- It must be set in `.env` and is validated at application startup — the app fails fast if the KEK is absent or malformed.
- The zero-value KEK (`000...000`) in `.env.example` is a documentation placeholder. It will fail any FIPS-compliant entropy check and **must not** be used in a real environment.
- In production (Track B), `ENCRYPTION_KEK` is replaced by a reference to a KMS-managed key; the `encrypt()` / `decrypt()` function signatures remain unchanged.

### Implementation: `src/common/encryption.ts`

The module exports exactly two functions:

```typescript
export function encrypt(plaintext: string): Buffer   // returns opaque blob for _ct column
export function decrypt(ciphertext: Buffer): string  // returns original plaintext
```

All special-care PII writes call `encrypt()` before `prisma.*.create/update`. All special-care PII reads call `decrypt()` after fetching the row — and only within `appi.service.ts` (data-subject export) or test helpers. Normal API responses never decrypt `_ct` columns.

### Standard PII: cleartext + response-time masking

Standard PII (`reporter_name`, `reporter_phone` cleartext copy, `reporter_email` cleartext copy, `loss_location_detail`) is stored in plaintext columns. Masking is applied at response time by `pii-mask.util.ts` via the `maskByAppiTier()` function. See ADR-003 for the masking rules.

Note: `reporter_phone` and `reporter_email` have *both* a cleartext column (for search / business operations by authorised roles) and an encrypted `_ct` column (for APPI Article 28 export, which must return the canonical stored value). This dual-column pattern is intentional: it avoids decrypting on every list query while still providing the encrypted authoritative copy for subject access requests.

---

## Consequences

### Positive

- **Database breach containment.** A raw Postgres dump exposes only ciphertext blobs for Article 17 fields. An attacker cannot reconstruct special-care PII without the KEK.
- **APPI Article 17 compliance (POC posture).** Encryption at rest satisfies the "appropriate security management measures" (安全管理措置) requirement under APPI Article 20 for special-care information.
- **Single implementation path.** One file (`encryption.ts`) is the only place AES-GCM is implemented. There is no risk of different modules using different ciphers or IVs.
- **KMS-ready.** Envelope encryption is structurally identical to the pattern used by AWS KMS, GCP KMS, and Azure Key Vault. Track B can replace the env-KEK with a KMS call by editing one function body.
- **Audit trail unaffected.** `AuditEvent` rows carry `payload_hash` of the normalised event, not the raw PII values. The audit log is tamper-evident without containing decryptable PII.

### Negative / Accepted trade-offs

- **No field-level search on `_ct` columns.** Searching by government ID or bank account requires decryption in application memory. This is acceptable because: (a) those fields are never searched in normal operations — only surfaced in APPI Article 28 exports; (b) the alternative (deterministic encryption for searchability) breaks semantic security.
- **Dual-column for phone/email is redundant storage.** Justified by the operational need for case-insensitive search on cleartext + the regulatory need to provide an encrypted canonical copy in subject access requests.
- **KEK is a single point of failure (Track A).** If `ENCRYPTION_KEK` is lost, all `_ct` data is unrecoverable. Mitigated in POC by: the data is synthetic / seeded; production requires KMS with hardware-backed key storage (Track B).
- **No key rotation in Track A.** Re-wrapping DEKs after KEK rotation is a Track B operational procedure. Documented; not implemented.

---

## Alternatives Considered

### Option 1: No encryption, masking only

Rejected. APPI Article 17 special-care information requires more than access control. A compromised database credential bypasses all application-layer masking. Masking-only is acceptable for standard PII; it is not sufficient for Article 17 fields.

### Option 2: Postgres `pgcrypto` column-level encryption

Rejected for Track A. `pgcrypto` requires the KEK to be present in SQL queries, which means the key appears in Postgres `pg_stat_activity` logs and query plans — a APPI audit risk. Application-layer encryption keeps the key out of the database entirely.

### Option 3: Transparent Data Encryption (TDE) at the Postgres / cloud storage level

Rejected as *insufficient alone*. TDE protects against physical disk theft; it does not protect against a compromised Postgres credential (the database engine decrypts transparently for any authenticated query). We need field-level protection that survives a compromised DB user. TDE may be *added* in Track B as a defence-in-depth layer; it does not replace this ADR.

### Option 4: Deterministic encryption (same plaintext → same ciphertext)

Rejected. Deterministic encryption (e.g. AES-SIV) would allow equality-search on `_ct` columns. However, it enables frequency analysis: two claims with the same government ID would share a ciphertext, leaking that the same individual appears on multiple claims. For APPI Article 17 fields this is unacceptable. Probabilistic AES-256-GCM (random IV per record) is required.

---

## Compliance Traceability

| APPI requirement | How this ADR satisfies it |
|---|---|
| Art. 17 — Handling of special-care personal information | `_ct` fields encrypted; never returned in normal API responses |
| Art. 20 — Security management measures (安全管理措置) | AES-256-GCM encryption at rest; access restricted to `appi.service.ts` |
| Art. 28 — Right to disclosure (開示請求) | `GET /claims/:id/data-subject-export` decrypts and returns all PII; see APPI module |
| Art. 19 — Correction and deletion | `DELETE /claims/:id/personal-data-anonymise` overwrites cleartext and `_ct` blobs; audit trail preserved |

---

## Related ADRs

- **ADR-003** — Role masking by APPI tier (response-time masking for standard PII; complements this ADR which handles special-care PII)
- **ADR-002** — Audit log immutability (audit events carry `payload_hash`, not PII values)

---

## Implementation Reference

| File | Role |
|---|---|
| `src/common/encryption.ts` | `encrypt()` / `decrypt()` — the single AES-256-GCM implementation |
| `src/common/pii-mask.util.ts` | Response-time masking for standard PII; does not touch `_ct` columns |
| `src/appi/appi.service.ts` | The only service that calls `decrypt()` on `_ct` columns in normal operation |
| `prisma/schema.prisma` | All `_ct` columns typed as `Bytes` (`@db.ByteA`) |
| `.env.example` | `ENCRYPTION_KEK` placeholder with security warning |
| `docs/adr/001-encryption.md` | This document |

---

## Track B Follow-On Actions

1. Replace `ENCRYPTION_KEK` env var with a reference to a KMS-managed key (AWS KMS / GCP KMS). `encryption.ts` function signatures are unchanged; only the key-fetching implementation changes.
2. Implement DEK re-wrapping procedure for KEK rotation.
3. Add TDE at the Postgres cloud volume level as defence-in-depth.
4. Add Postgres RLS policy restricting `SELECT` on `_ct` columns to the application role only (preventing DBA-level access without application decryption).
5. Evaluate `pgaudit` extension to log any direct `SELECT` on `_ct` columns at the DB layer.