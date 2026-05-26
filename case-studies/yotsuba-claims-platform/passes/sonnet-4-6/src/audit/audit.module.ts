// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/audit/audit.module.ts
//
// Audit module. Wires together:
//   - AuditController  — GET /audit (auditor-only, read-only)
//   - AuditService     — append-only write + paginated query
//
// This module is exported so that other modules (claims, reserves, appi)
// can inject AuditService directly when they need to record audit events
// outside of the interceptor flow.
//
// DESIGN INVARIANT (ADR-002): The audit log has no update or delete pathway.
// AuditService is the single write path; AuditController is read-only.
// =============================================================================

import { Module } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

@Module({
  controllers: [AuditController],
  providers: [
    AuditService,
    // PrismaService is provided here so this module can be used standalone
    // (e.g. in integration tests) without depending on a global PrismaModule.
    // When AppModule imports both PrismaService globally and this module,
    // NestJS deduplicates the provider — no double-instantiation.
    PrismaService,
  ],
  exports: [
    // Exported so that ClaimsModule, ReservesModule, AppiModule, and the
    // AuditInterceptor can inject AuditService without re-declaring it.
    AuditService,
  ],
})
export class AuditModule {}