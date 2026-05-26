# ADR 001: Encryption of Sensitive Customer and Claims Data

## Status
Accepted

## Context
Our system manages highly sensitive customer information (Personally Identifiable Information or PII, such as names, contact details, and identification numbers) and insurance/reimbursement claims. Unauthorized access to this data poses severe legal, financial, and reputational risks. To comply with modern data protection standards (such as GDPR, HIPAA, and local financial regulations) and to ensure robust security, we must establish a clear strategy for encrypting data both in transit and at rest.

Specifically, we need to address:
1. **Data in Transit**: Protecting data as it moves between clients, the NestJS backend, and the database.
2. **Data at Rest (Storage)**: Protecting data stored in the database from physical theft or unauthorized database access.
3. **Field-Level Encryption (FLE)**: Protecting highly sensitive fields (e.g., national identifiers, financial details) even if the database itself is compromised or accessed by unauthorized database administrators.

## Decision
We will implement a multi-layered encryption strategy across the application lifecycle:

### 1. Encryption in Transit
- **Client-to-Server**: All external HTTP traffic must be encrypted using TLS 1.3 (with TLS 1.2 as the absolute minimum fallback). Non-HTTPS traffic will be redirected to HTTPS at the load balancer/ingress level.
- **Server-to-Database**: The connection between the NestJS application (via Prisma) and the database must enforce SSL/TLS. The database connection string (`DATABASE_URL`) must include parameters enforcing SSL (e.g., `sslmode=require` or `ssl=true`).

### 2. Database-Level Encryption at Rest
- We will leverage cloud-native **Transparent Data Encryption (TDE)** or storage-level encryption (e.g., AWS KMS-managed EBS/RDS encryption) for the underlying database storage. This ensures that physical backups, snapshots, and disks are encrypted at rest without application-level overhead.

### 3. Application-Level Field-Level Encryption (FLE)
For highly sensitive fields (such as national IDs, SSNs, or bank account numbers) within the `Customer` and `Claim` entities, we will perform encryption at the application layer before writing to the database.
- **Algorithm**: We will use **AES-256-GCM** (Advanced Encryption Standard in Galois/Counter Mode) for authenticated encryption, providing both confidentiality and integrity.
- **Implementation**:
  - A dedicated `EncryptionService` will be created within a shared utility module.
  - Prisma middleware or client extensions will be utilized to automatically encrypt designated fields during write operations (`create`, `update`) and decrypt them during read operations (`findUnique`, `findMany`, etc.).
  - Each encrypted field will store a payload containing the initialization vector (IV), the auth tag, and the ciphertext (typically formatted as `iv:authTag:ciphertext` in a single string or JSON structure).

### 4. Key Management
- Encryption keys will never be hardcoded or stored in the repository.
- For local development, keys will be loaded via environment variables (`.env`).
- For production, keys will be managed using a secure Key Management Service (KMS) such as AWS KMS, HashiCorp Vault, or Azure Key Vault, and injected into the application container at runtime.
- We will support key versioning to allow seamless key rotation without breaking access to historically encrypted data.

## Consequences

### Positive (Benefits)
- **Regulatory Compliance**: Meets strict standards for protecting PII and financial/health data.
- **Defense in Depth**: Even if the database backup is leaked or an attacker gains read-only access to the database, highly sensitive fields remain unreadable without the encryption keys.
- **Data Integrity**: AES-256-GCM ensures that any tampering with the encrypted database fields is detected during decryption.

### Negative (Trade-offs & Mitigations)
- **Query Limitations**: Encrypted fields cannot be easily searched using standard SQL `LIKE` or exact match queries.
  - *Mitigation*: For fields that require exact-match lookups (e.g., searching by SSN), we will implement a **Blind Index** pattern (storing a secure, salted SHA-256 hash of the plaintext field in a separate column) to allow fast lookups without exposing the plaintext.
- **Performance Overhead**: Application-level encryption/decryption introduces CPU overhead.
  - *Mitigation*: Limit FLE strictly to highly sensitive fields rather than encrypting entire tables.
- **Key Management Complexity**: Managing key rotation and access policies adds operational complexity.
  - *Mitigation*: Use managed cloud KMS solutions with automated rotation policies.