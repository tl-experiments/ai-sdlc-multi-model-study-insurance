# ADR-001: PII Encryption — AES-256-GCM, APPI-Tier-Aware

**Status:** Accepted  
**Date:** 2024-01-15  
**Context:** Yotsuba Insurance Claims Processing Platform (Track A)  
**Deciders:** Architecture team  

## Problem Statement

The Yotsuba Claims Platform must handle personally identifiable information (PII) across multiple claim records. Japanese data protection law — the Act on Protection of Personal Information (APPI) — distinguishes between standard PII and *special-care personal information* (Article 17), which requires stricter handling:

- **Standard PII:** name, phone, email, address (stored cleartext; role-based masking in API responses)
- **Special-care PII:** government ID, medical information, bank account details (must be encrypted at rest; never returned in API responses except via explicit data-subject-export)

Without a clear encryption strategy, we risk:
1. Regulatory non-compliance (APPI Article 17 violation)
2. Inconsistent PII handling across the codebase
3. Difficulty auditing which fields are protected and how
4. Operational burden of key management at scale

## Decision

We adopt a **two-tier PII protection model**:

### Tier 1: Standard PII (Cleartext + Role-Based Masking)

Fields: `reporter_name`, `reporter_phone`, `reporter_email`, `loss_location_detail`, `policy_number`

**Storage:** Stored as cleartext in PostgreSQL (no encryption at rest).

**Protection:** Role-based masking applied at response time via `maskByAppiTier()` utility function:
- `agent` — masked (redacted) in list views; cleartext only on own intake claims for 24 hours
- `adjuster` — cleartext on assigned claims; masked on non-assigned claims
- `manager` — cleartext on reports' claims; masked on others
- `auditor` — cleartext on all claims (audit context)
- `siu_referrer` — masked on all claims except flagged claims

**Rationale:** Standard PII is lower-sensitivity under APPI. Cleartext storage simplifies querying (e.g., filtering by reporter name) and reduces operational complexity. Role-based masking at response time provides adequate protection for the API layer.

### Tier 2: Special-Care PII (AES-256-GCM Encryption)

Fields: `insured_government_id_ct`, `bank_account_for_payout_ct`, `injury_details_ct`, `reporter_phone_ct`, `reporter_email_ct`, `witness_phone_ct`

**Storage:** Encrypted at rest using AES-256-GCM. Stored as `Bytes` in PostgreSQL (binary blob).

**Encryption Envelope:**
- **Algorithm:** AES-256-GCM (authenticated encryption)
- **Key Derivation:** Per-record Data Encryption Key (DEK) + environment-supplied Key Encryption Key (KEK)
- **Implementation:** Reuse Phase 1 pattern (`src/common/encryption.ts`)
  - DEK is randomly generated per record (32 bytes)
  - DEK is encrypted with KEK and stored alongside the ciphertext
  - GCM provides both confidentiality and authenticity (no separate MAC needed)
  - Nonce is randomly generated per encryption operation (12 bytes)

**API Exposure:** Never returned in standard API responses. Only accessible via:
1. `GET /claims/:id/data-subject-export` (APPI Article 28 disclosure right; manager or auditor only)
2. Internal service-to-service calls (e.g., payout processing in Track B)

**Rationale:** APPI Article 17 requires special-care PII to be handled with heightened security. Encryption at rest protects against database compromise. Restricting API exposure to explicit data-subject-export endpoints ensures PII is only disclosed when legally required.

## Implementation Details

### Encryption Service

```typescript
// src/common/encryption.ts

export class EncryptionService {
  private readonly kek: Buffer; // Key Encryption Key from env

  constructor(private readonly config: ConfigService) {
    const kekBase64 = this.config.get<string>('ENCRYPTION_KEK');
    if (!kekBase64) {
      throw new Error('ENCRYPTION_KEK environment variable is required');
    }
    this.kek = Buffer.from(kekBase64, 'base64');
    if (this.kek.length !== 32) {
      throw new Error('ENCRYPTION_KEK must be 32 bytes (256 bits)');
    }
  }

  /**
   * Encrypt plaintext using AES-256-GCM.
   * Returns a buffer containing: [DEK (encrypted, 64 bytes)] + [nonce (12 bytes)] + [ciphertext] + [tag (16 bytes)]
   */
  encrypt(plaintext: string): Buffer {
    const dek = crypto.randomBytes(32); // Data Encryption Key
    const nonce = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', dek, nonce);
    const ciphertext = Buffer.concat([
      cipher.update(plaintext, 'utf8'),
      cipher.final(),
    ]);
    const tag = cipher.getAuthTag();

    // Encrypt DEK with KEK
    const dekCipher = crypto.createCipheriv('aes-256-gcm', this.kek, crypto.randomBytes(12));
    const encryptedDek = Buffer.concat([
      dekCipher.update(dek),
      dekCipher.final(),
    ]);
    const dekTag = dekCipher.getAuthTag();
    const dekNonce = crypto.randomBytes(12);

    // Return: [encrypted DEK (64 bytes)] + [DEK nonce (12 bytes)] + [DEK tag (16 bytes)] + [data nonce (12 bytes)] + [ciphertext] + [tag (16 bytes)]
    return Buffer.concat([
      encryptedDek,
      dekTag,
      dekNonce,
      nonce,
      ciphertext,
      tag,
    ]);
  }

  /**
   * Decrypt ciphertext encrypted by encrypt().
   */
  decrypt(ciphertext: Buffer): string {
    const encryptedDek = ciphertext.slice(0, 32);
    const dekTag = ciphertext.slice(32, 48);
    const dekNonce = ciphertext.slice(48, 60);
    const nonce = ciphertext.slice(60, 72);
    const ct = ciphertext.slice(72, -16);
    const tag = ciphertext.slice(-16);

    // Decrypt DEK
    const dekDecipher = crypto.createDecipheriv('aes-256-gcm', this.kek, dekNonce);
    dekDecipher.setAuthTag(dekTag);
    const dek = Buffer.concat([
      dekDecipher.update(encryptedDek),
      dekDecipher.final(),
    ]);

    // Decrypt data
    const decipher = crypto.createDecipheriv('aes-256-gcm', dek, nonce);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(ct),
      decipher.final(),
    ]);

    return plaintext.toString('utf8');
  }
}
```

### Schema Representation

Special-care PII fields are stored as `Bytes` in Prisma:

```prisma
model Claim {
  // Standard PII (cleartext)
  reporter_name               String
  reporter_phone              String?     // Dual storage: cleartext for masking logic
  reporter_email              String?
  loss_location_detail        String

  // Special-care PII (encrypted)
  insured_government_id_ct    Bytes?      // APPI Article 17
  bank_account_for_payout_ct  Bytes?
  injury_details_ct           Bytes?
  reporter_phone_ct           Bytes?      // Encrypted version (dual storage)
  reporter_email_ct           Bytes?
}

model WitnessStatement {
  witness_name                String
  witness_phone_ct            Bytes?      // Encrypted
}
```

### Masking Utility

```typescript
// src/common/pii-mask.util.ts

export interface MaskContext {
  callerRole: UserRole;
  claimAssignedAdjusterId?: string;
  callerUserId: string;
}

export function maskByAppiTier(
  claim: Claim,
  context: MaskContext,
): Partial<Claim> {
  const isAssignedAdjuster =
    context.callerRole === 'adjuster' &&
    claim.assigned_adjuster_id === context.callerUserId;
  const isManager = context.callerRole === 'manager';
  const isAuditor = context.callerRole === 'auditor';

  const masked = { ...claim };

  // Standard PII masking
  if (!isAssignedAdjuster && !isManager && !isAuditor) {
    masked.reporter_name = '***';
    masked.reporter_phone = '***';
    masked.reporter_email = '***';
    masked.loss_location_detail = masked.loss_location_prefecture; // Prefecture only
  }

  // Special-care PII: never in API (even for auditor in standard responses)
  // Only returned via explicit data-subject-export endpoint
  delete masked.insured_government_id_ct;
  delete masked.bank_account_for_payout_ct;
  delete masked.injury_details_ct;
  delete masked.reporter_phone_ct;
  delete masked.reporter_email_ct;

  return masked;
}
```

### Data-Subject Export (APPI Article 28)

The `GET /claims/:id/data-subject-export` endpoint decrypts special-care PII and returns it in a single JSON document:

```typescript
// src/appi/appi.service.ts

export class AppiService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly encryption: EncryptionService,
  ) {}

  async dataSubjectExport(claimId: string): Promise<DataSubjectExportDto> {
    const claim = await this.prisma.claim.findUnique({
      where: { id: claimId },
    });

    if (!claim) {
      throw new NotFoundException('Claim not found');
    }

    // Decrypt special-care PII
    const decrypted = {
      insured_government_id: claim.insured_government_id_ct
        ? this.encryption.decrypt(claim.insured_government_id_ct)
        : null,
      bank_account_for_payout: claim.bank_account_for_payout_ct
        ? this.encryption.decrypt(claim.bank_account_for_payout_ct)
        : null,
      injury_details: claim.injury_details_ct
        ? this.encryption.decrypt(claim.injury_details_ct)
        : null,
    };

    return {
      subject_identifier: `reporter_name=${claim.reporter_name}`,
      export_generated_at: new Date(),
      claims: [
        {
          claim_id: claim.id,
          policy_number: claim.policy_number,
          reporter_name: claim.reporter_name,
          reporter_phone: claim.reporter_phone,
          reporter_email: claim.reporter_email,
          insured_government_id: decrypted.insured_government_id,
          bank_account_for_payout: decrypted.bank_account_for_payout,
          injury_details: decrypted.injury_details,
          loss_location_detail: claim.loss_location_detail,
          incident_type: claim.incident_type,
          initial_description: claim.initial_description,
          created_at: claim.created_at,
        },
      ],
    };
  }
}
```

## Consequences

### Positive

1. **APPI Compliance:** Special-care PII is encrypted at rest and restricted to explicit disclosure endpoints. Standard PII is protected via role-based masking.
2. **Operational Simplicity:** Single KEK in environment; no per-user key management. DEK is derived per record, so key rotation is straightforward (Track B).
3. **Auditability:** Encryption/decryption is centralized in `EncryptionService`. All special-care PII access is logged via `AuditInterceptor`.
4. **Performance:** Standard PII queries (e.g., filtering by reporter name) are fast (no decryption needed). Special-care PII is only decrypted on explicit request.
5. **Consistency:** Single source of truth for masking logic (`maskByAppiTier()`). Adding a new sensitive field requires one line in the masking function.

### Negative

1. **Encryption Overhead:** Decryption adds latency to data-subject-export requests. Acceptable for Track A (low volume); may need caching in production.
2. **Key Management:** KEK must be securely stored in environment. Production deployment requires a real KMS (Track B); POC uses env variable.
3. **Dual Storage:** Some fields (e.g., `reporter_phone`) are stored both cleartext and encrypted. Adds storage overhead (~2x for those fields) but simplifies masking logic.
4. **Backward Compatibility:** Existing cleartext data must be migrated to encrypted form. Handled via Prisma migration script (Track B).

## Alternatives Considered

### 1. Encrypt All PII

**Rejected:** Encrypting standard PII (name, email) would require decryption for every query (filtering, sorting). Unacceptable performance impact. Role-based masking is sufficient for standard PII under APPI.

### 2. Field-Level Encryption (Transparent)

**Rejected:** Prisma does not support transparent field-level encryption. Would require custom middleware or a separate encryption layer, adding complexity. Explicit encryption in the service layer is clearer and more auditable.

### 3. Database-Level Encryption (TDE)

**Rejected:** PostgreSQL Transparent Data Encryption (TDE) protects the entire database but does not protect against application-layer breaches or insider threats. Application-level encryption is required for APPI Article 17 compliance.

### 4. Tokenization (PII Replacement)

**Rejected:** Tokenization (replacing PII with tokens) would require a separate tokenization service and token-to-PII mapping. Adds operational complexity and does not align with APPI Article 28 (data-subject-export must return actual PII, not tokens).

## Testing Strategy

1. **Unit Tests:** Encryption/decryption round-trip for each special-care field.
2. **Integration Tests:** Verify that special-care PII is not returned in standard API responses; only in data-subject-export.
3. **Role-Based Masking Tests:** Verify that each role sees the correct level of PII masking.
4. **Audit Tests:** Verify that decryption of special-care PII is logged in `AuditEvent`.

## References

- **APPI (Act on Protection of Personal Information):** https://www.ppc.go.jp/en/
- **APPI Article 17 (Special-Care Personal Information):** Requires stricter handling of government ID, medical, and financial information.
- **APPI Article 28 (Data-Subject Disclosure Right):** Individuals have the right to request all PII held about them.
- **AES-256-GCM:** NIST SP 800-38D; authenticated encryption standard.
- **Phase 1 Encryption Pattern:** `src/common/encryption.ts` (Workforce Ops platform).

## Related ADRs

- **ADR-003:** Role masking by APPI tier (response-time filtering)
- **ADR-002:** Audit log immutability (all PII access is logged)