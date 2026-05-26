# ADR-001 — PII encryption: AES-256-GCM under an env-supplied KEK, APPI-tier-aware

- **Status:** Accepted (Track A)
- **Date:** 2024-09
- **Deciders:** Claims platform engineering; reviewed against the locked `brief.md` PII inventory and `design.md` §1 schema.
- **Related ADRs:** ADR-003 (role masking by APPI tier), ADR-002 (audit immutability).
- **Related code:** `src/common/encryption.ts`, `src/common/pii-mask.util.ts`, `prisma/schema.prisma` (`*_ct` columns).

---

## 1. Context

The target customer is a JFSA-regulated Japanese P&C insurance carrier. The Act on the Protection of Personal Information (個人情報保護法, *APPI*) draws a sharp line between two grades of personal data, and our schema must respect that line at rest and on the wire:

- **Standard PII** — names, postal addresses, phone numbers, email addresses, policy numbers. Cleartext storage is acceptable provided responses are role-scoped and audited.
- **Special-care personal information (要配慮個人情報, APPI Article 17)** — government-issued identifiers (マイナンバー / driver's licence numbers), bank account details for payout, and medical information including `injury_details`. APPI raises the bar: collection requires explicit consent (captured at FNOL via `appi_consent_version` and `appi_consent_at`), and storage demands a controls regime stricter than "the database is hard to reach." In practice, regulators and reviewers expect at-rest encryption with a key separated from the data.

The brief's PII inventory (`brief.md` §PII inventory) is unambiguous about which fields land in which tier:

| Field | Tier |
|---|---|
| `reporter_name`, `reporter_email`, `reporter_phone`, `loss_location` | Standard |
| `policy_number` | Sensitive (financial linkage) — treated as standard PII for storage, role-masked for response |
| `insured_government_id`, `bank_account_for_payout`, `injury_details` | Special-care (Article 17) |

The schema in `design.md` §1 codifies this by suffixing every special-care field with `_ct` and typing it as `Bytes` — a deliberate signal that the column holds ciphertext, not cleartext. This ADR records *how* that ciphertext is produced, the key management model, and the operational consequences.

A secondary constraint: Track A reuses the Phase 1 (Workforce Ops) encryption envelope rather than inventing a new one. Phase 1 already shipped an AES-256-GCM + env-supplied KEK pattern that has been reviewed, tested, and integrated with the audit interceptor. Reinventing it here would add risk without adding value; the Track B KMS migration (see §7) will replace the env KEK uniformly across both studies.

## 2. Decision

All special-care PII columns — every `*_ct` field in `prisma/schema.prisma` — are stored as **AES-256-GCM ciphertext** produced by `src/common/encryption.ts`. The cryptographic envelope is:

1. **Per-record DEK.** For each record write, the encryption module generates a fresh 256-bit data-encryption key (`crypto.randomBytes(32)`).
2. **Per-record IV.** A fresh 96-bit initialisation vector (`crypto.randomBytes(12)`) is generated for the GCM operation. Reusing an IV under the same key would catastrophically break GCM's confidentiality and integrity guarantees; per-record IVs make reuse impossible.
3. **Plaintext encryption.** The plaintext (UTF-8 bytes of the field value) is encrypted under the DEK with AES-256-GCM, producing a ciphertext and a 128-bit authentication tag.
4. **DEK wrapping.** The DEK is wrapped (encrypted) under the env-supplied **key-encryption key** `PII_KEK` — a 256-bit symmetric key supplied via the `PII_KEK` environment variable as 32 raw bytes encoded in base64. Wrapping uses AES-256-GCM with its own fresh IV.
5. **On-disk layout.** The `Bytes` column stores a single concatenated envelope: `version || dek_iv || wrapped_dek || wrapped_dek_tag || data_iv || data_tag || ciphertext`. A one-byte version prefix reserves room for future envelope changes (see §7).
6. **Decryption.** The reverse: split the envelope on its fixed-width fields, unwrap the DEK under `PII_KEK`, then decrypt the payload under the DEK. GCM's tag is verified on both unwrap and decrypt; any tampering raises and the request fails closed with a 500 from the global exception filter — never a leaked partial value.

Standard PII (`reporter_name`, `loss_location_*`, etc.) is stored as plain UTF-8 strings on the corresponding non-`_ct` columns. It is **not** encrypted at rest, because the protection model for standard PII is role-based response masking (ADR-003), not at-rest secrecy. Encrypting standard PII would inflate every read, defeat indexability on fields like `loss_location_prefecture`, and add no defence against the realistic threat model (a legitimately authenticated caller with the wrong role).

The `policy_number` field is treated as standard PII for storage purposes — cleartext, queryable — but is role-masked at the response layer (auditors see full; non-assigned adjusters see a redacted suffix).

## 3. APPI tier rules — the single source of truth

The tier assignment is canonical and lives in two places that must stay in lockstep:

- **At rest:** the `_ct` suffix on a Prisma column declares special-care tier. If a field's column name ends in `_ct`, it must be encrypted; if it does not, it must not be. This convention is mechanical and enforceable by lint or a schema unit-test.
- **On the wire:** `src/common/pii-mask.util.ts` declares each field's tier explicitly in a typed map. The masking interceptor (ADR-003) consults this map. Adding a new sensitive field requires (a) a `_ct` column in the schema, (b) an entry in the tier map, (c) encryption on write in the owning service, and (d) a decision in `pii-mask.util.ts` about who can ever see it decrypted.

The special-care fields enumerated by this ADR:

| Schema field | Owning entity | Plaintext source |
|---|---|---|
| `reporter_phone_ct` | `Claim` | FNOL DTO `reporter_phone` |
| `reporter_email_ct` | `Claim` | FNOL DTO `reporter_email` |
| `insured_government_id_ct` | `Claim` | FNOL DTO (only required for certain incident types in Track B; column exists in Track A) |
| `bank_account_for_payout_ct` | `Claim` | Settlement workflow (Track B writes; Track A reads via APPI export) |
| `injury_details_ct` | `Claim` | FNOL DTO when `injury_reported=true` |
| `witness_phone_ct` | `WitnessStatement` | Witness statement DTO `witness_phone` |

The Track A read surface returns these fields only via `GET /claims/:id/data-subject-export` (APPI Article 28 disclosure right), gated to `auditor` and `manager` roles. No ordinary `GET /claims/:id` path returns them, decrypted or otherwise.

## 4. Key management — `PII_KEK`

The single key on which the entire envelope rests is `PII_KEK`. The operational rules:

- **Format.** 32 raw bytes (256 bits), encoded as base64 in the environment. The encryption module rejects any value that does not decode to exactly 32 bytes; misconfiguration is a fail-fast at boot rather than a silent downgrade.
- **Provenance.** In development the operator generates one with `node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"` and pastes it into `.env`. In production it is sourced from the platform's secrets manager and injected as an env var by the runtime — this ADR does not specify the secrets manager.
- **Scope.** Process-wide singleton, read once at startup. The module surfaces a `getKek()` function backed by a memoised parse; the raw bytes never leave the process boundary.
- **Rotation.** **Not supported in Track A.** Rotating `PII_KEK` without re-encrypting every `*_ct` column would render existing rows unreadable. The README documents this explicitly. Track B introduces a real KMS with per-row key-id headers; see §7.
- **Backup.** The operator is responsible for backing up `PII_KEK` alongside the database, because a database backup without the key is unrecoverable. This is intentional — it is the property that gives at-rest encryption its security value.

The envelope's one-byte version prefix (`version=0x01` in Track A) reserves room for a future rotation strategy: a Track B writer could stamp `version=0x02` with a `kek_id` header, allowing both versions to coexist while rows are gradually re-wrapped.

## 5. Threat model — what this defends, and what it does not

In scope (the attacks AES-256-GCM + KEK separation defends against):

- **Database disk theft / backup leak.** Without `PII_KEK`, the `*_ct` columns are computationally infeasible to decrypt. Standard backup posture (db dumps in S3) does not leak special-care PII so long as `PII_KEK` is not in the same blast radius.
- **SQL injection that exfiltrates rows.** The attacker gets ciphertext, not plaintext. This is the principal defence for the APPI Article 17 tier.
- **Read replicas / analytics warehouses.** Downstream consumers that receive replicated rows see only ciphertext for `*_ct` columns. Decryption is centralised in the API process.
- **Tampering.** GCM's authentication tag means any modification to a ciphertext is detected on decrypt and surfaces as a hard failure — there is no path by which a corrupted row silently returns wrong plaintext.

Out of scope (the attacks this does *not* defend against, and which other controls address):

- **A legitimately authenticated caller with the wrong role.** This is the realistic insider-threat model and is addressed by ADR-003 (role masking) and the RBAC matrix, *not* by encryption.
- **Memory disclosure on a compromised API host.** A process that holds `PII_KEK` in memory and reads decrypted PII into responses is, by construction, in possession of plaintext at runtime. Container hardening, host isolation, and least-privilege are the controls here.
- **Side-channel attacks on the AES implementation.** We rely on Node's `crypto` module's implementation; this ADR does not attempt to defend against timing or cache side-channels at the cryptographic layer.
- **Key compromise.** If `PII_KEK` leaks, every `*_ct` column in the database is exposed. This is the property the operator is paid to prevent and is the reason Track B migrates to a real KMS where the key never leaves the HSM boundary.

## 6. Consequences

### Positive

- **APPI Article 17 storage demand is demonstrably met.** A reviewer can `SELECT reporter_phone_ct FROM "Claim" LIMIT 1` and see a binary envelope, not a phone number.
- **Single function owns the cryptographic envelope.** `src/common/encryption.ts` exports `encryptPii(plaintext: string): Buffer` and `decryptPii(envelope: Buffer): string`. Every service that touches special-care fields goes through these two functions; there is no second cryptographic path to review.
- **Schema-level convention (`_ct` suffix) is mechanically enforceable.** A unit test asserts that every `Bytes` column in the Prisma schema ends in `_ct` and every `_ct` column is `Bytes` — this prevents the convention from drifting.
- **No floating-point or string-equality pitfalls.** Ciphertexts are `Bytes`; comparisons happen post-decrypt on UTF-8 strings.
- **GCM provides confidentiality and integrity in one primitive.** No separate HMAC step to misconfigure.

### Negative / accepted costs

- **`*_ct` columns are not queryable.** You cannot `WHERE reporter_email_ct = ?` against ciphertext. This is fine for the Track A read paths (data-subject-export is the only consumer and it joins on `Claim.id`) but rules out, e.g., a future "find all claims for this email" feature without deterministic encryption — explicitly Track B.
- **`PII_KEK` is a deployment-critical secret.** Loss of the key bricks the historical PII. The README states this and the operator is responsible.
- **Per-record DEKs add ~80 bytes of overhead per encrypted field.** This is negligible (a phone number's plaintext is ~12 bytes; the envelope is ~92 bytes) and worth the security property that no two records share a DEK.
- **Track A has no key rotation pathway.** Adding one mid-Track-A would have introduced complexity without operational benefit; the version-prefix byte preserves the option for Track B.

## 7. Track B follow-up

The items deferred to Track B that this ADR explicitly does not address:

- **Real KMS integration** (AWS KMS, GCP KMS, or the customer's on-prem HSM). The DEK wrapping operation moves from a local AES-256-GCM under `PII_KEK` to a KMS `Encrypt` / `Decrypt` API call. The on-disk envelope gains a `kek_id` header; the `version=0x01` rows continue to decrypt via the legacy path until re-wrapped.
- **Key rotation.** With KMS in place, a rolling re-wrap job migrates rows from `version=0x01` to `version=0x02` (KMS-wrapped) without downtime.
- **Deterministic encryption for searchable fields** if a Track B feature genuinely needs `WHERE email_ct = ?` semantics. The current decision is to defer this until the use case is real; deterministic encryption has its own privacy trade-offs (it leaks equality) and should not be adopted speculatively.
- **At-rest re-encryption tooling.** A maintenance command that walks every `*_ct` column and re-wraps under a new KEK, with progress tracking. Not needed until rotation is needed.
- **Postgres column-level access controls.** Belt-and-braces: even with role-scoped API responses, restricting which DB roles can `SELECT *_ct` adds defence in depth. Track B alongside the RLS work for `AuditEvent` (ADR-002).

## 8. References

- 個人情報の保護に関する法律 (APPI) — Article 17 (special-care personal information), Article 28 (disclosure right).
- `brief.md` — PII inventory and APPI compliance hooks.
- `design.md` §1 — Prisma schema, `*_ct` columns and `Bytes` typing.
- ADR-003 — role masking by APPI tier (the response-layer complement to this ADR).
- ADR-002 — audit immutability (the audit interceptor records that decryption occurred via the `data-subject-export` action, providing accountability for plaintext access).
- NIST SP 800-38D — recommendation for AES-GCM, including the IV-uniqueness requirement that motivates the per-record IV.