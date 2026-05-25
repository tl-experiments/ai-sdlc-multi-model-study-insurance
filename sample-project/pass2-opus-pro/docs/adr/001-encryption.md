# ADR-001: PII Encryption at Rest

**Status:** Accepted · **Pass:** 1 (Opus-only)

## Context
The Workforce Ops Service stores high-sensitivity PII (`government_id`, `bank_account`, `salary_base`) that must not be readable from a DB-only breach.

## Decision
Envelope encryption with AES-256-GCM. Each record holds its own randomly generated 32-byte Data Encryption Key (DEK). The DEK is wrapped with a Key Encryption Key (KEK) loaded from `process.env.KEK_HEX` (32 bytes hex). On-disk blob layout: `wrappedDek(32) || wrapTag(16) || iv(12) || tag(16) || ciphertext(N)`, base64-encoded.

## Consequences
- **+** Self-contained, no external KMS dependency for POC. Each record has a unique DEK.
- **−** KEK rotation requires re-wrapping every DEK; needs a migration script for prod.
- **−** KEK is only as secure as the env supply chain. Move to KMS in prod.