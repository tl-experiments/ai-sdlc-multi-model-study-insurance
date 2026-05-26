# ADR 003: Role-Based Data Masking at the API Tier

## Status
Accepted

## Context
Our system processes and stores highly sensitive customer information, including Personally Identifiable Information (PII) such as national identifiers, phone numbers, email addresses, and financial details. While this data is encrypted at rest and in transit (as decided in [ADR 001](001-encryption.md)), it must be decrypted at the application layer to perform business logic.

However, not all authenticated users of the system require access to the full plaintext of this sensitive data. For example:
- A **Customer Support Representative** may only need to see the last four digits of a national identifier or phone number to verify a customer's identity.
- A **Claims Agent** may require full access to financial details to process a reimbursement claim.
- An **Auditor** may need to see metadata but not the actual sensitive values.
- An external **Customer** should only see their own fully decrypted data, never other customers' data.

To enforce the principle of least privilege and comply with data privacy regulations (such as GDPR and HIPAA), we must ensure that sensitive fields are dynamically masked or redacted based on the role of the authenticated user making the request.

We evaluated several approaches for implementing this:
1. **Database-Level Dynamic Data Masking (DDM)**: Hard to maintain, tightly couples the application to a specific database engine, and complicates local development and testing.
2. **Service-Layer Manual Masking**: Writing custom masking logic inside every service method is highly error-prone, leads to significant code duplication, and mixes presentation concerns with core business logic.
3. **API-Tier Declarative Masking**: Masking data at the boundary of the application (the API serialization layer) using decorators and interceptors. This keeps the core business logic clean and ensures a single, centralized point of enforcement.

## Decision
We will implement **Role-Based Data Masking at the API Tier** using NestJS Interceptors, custom decorators, and class-transformer serialization.

### 1. Declarative Masking Decorators
We will define a custom `@Mask` decorator that can be applied directly to properties on Data Transfer Objects (DTOs). This decorator will accept the roles authorized to see the unmasked data, along with a specific masking strategy.

```typescript
class CustomerDto {
  @Expose()
  id: string;

  @Expose()
  name: string;

  @Mask({ 
    roles: ['Admin', 'ClaimsAgent'], 
    strategy: MaskStrategy.LAST_FOUR 
  })
  @Expose()
  nationalId: string;

  @Mask({ 
    roles: ['Admin', 'ClaimsAgent', 'CustomerSupport'], 
    strategy: MaskStrategy.EMAIL 
  })
  @Expose()
  email: string;
}
```

### 2. Masking Strategies
We will support multiple standard masking strategies to handle different data types:
- **`FULL`**: Replaces the entire string with a fixed mask (e.g., `********`).
- **`LAST_FOUR`**: Masks all characters except the last four (e.g., `***-**-1234` or `******5678`).
- **`EMAIL`**: Masks the local part of an email address while keeping the domain visible (e.g., `j***e@example.com`).
- **`NULLIFY`**: Completely removes the field or sets it to `null` for unauthorized roles.

### 3. NestJS Role-Masking Interceptor
We will implement a global `RoleMaskingInterceptor` that intercepts outgoing HTTP responses:
- **Context Extraction**: The interceptor extracts the authenticated user's role from the request context (populated by the authentication/authorization guards).
- **Metadata Inspection**: It inspects the returned response object's class metadata to identify properties decorated with `@Mask`.
- **Dynamic Transformation**: If the user's role is not in the authorized list for a decorated property, the interceptor applies the specified `MaskStrategy` to the value before it is serialized and sent over the network.
- **Deep Traversal**: The interceptor will recursively traverse nested objects and arrays to ensure nested DTOs are also masked correctly.

### 4. Integration with Audit Logs
To ensure accountability, whenever a user with elevated privileges accesses unmasked sensitive data, the system will automatically trigger an audit log entry via the `AuditService` (as defined in [ADR 002](002-audit-immutability.md)), recording who accessed the unmasked data and when.

## Consequences

### Positive (Benefits)
- **Principle of Least Privilege**: Sensitive data is only exposed to users who strictly need it to perform their specific job functions.
- **Separation of Concerns**: Business logic in services remains completely unaware of masking rules. Services work with full plaintext data, while the API tier handles presentation-level security.
- **High Maintainability**: Masking rules are declared directly on DTOs, making it easy for developers and security auditors to see exactly how data is protected at a glance.
- **Consistency**: Centralizing the masking logic in a single interceptor guarantees that masking is applied uniformly across all API endpoints.

### Negative (Trade-offs & Mitigations)
- **Serialization Performance Overhead**: Recursively traversing response objects and inspecting metadata using reflection adds CPU overhead during serialization.
  - *Mitigation*: We will optimize the interceptor by caching class metadata lookups and skipping traversal for response payloads that do not contain decorated DTOs.
- **Risk of Accidental Exposure**: If a controller returns a raw database entity or a plain object instead of an instance of a decorated DTO class, the interceptor will not find the metadata, and masking will be bypassed.
  - *Mitigation*: We will enforce strict linting rules and code reviews requiring all controller endpoints to return typed DTOs instantiated via `plainToInstance` or NestJS's `ClassSerializerInterceptor`.