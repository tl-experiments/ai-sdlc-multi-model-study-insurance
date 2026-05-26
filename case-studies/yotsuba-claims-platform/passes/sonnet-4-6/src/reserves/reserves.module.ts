// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/reserves/reserves.module.ts
//
// Reserves module — wires together all services and controllers for the
// reserves management domain (Track A).
//
// Design reference: design.md §3 Module structure
// Brief reference:  brief.md §3 Reserves Management
//
// Provides:
//   ReservesController   — HTTP layer for all reserve + JFSA notification routes
//   ReservesService      — proposal, approval workflow, reserve history
//   ReservesJfsaService  — JFSA threshold NotificationToRegulator producer
//   ReservesExportService — IFRS17 reserve aggregation export
//
// Imports:
//   PrismaService  — database access (global module, no explicit import needed
//                    but included for clarity per Phase 1 conventions)
//   AuditModule    — AuditService required by ReservesService for ADR-002
// =============================================================================

import { Module } from '@nestjs/common';
import { ReservesController } from './reserves.controller';
import { ReservesService } from './reserves.service';
import { ReservesJfsaService } from './reserves-jfsa.service';
import { ReservesExportService } from './reserves-export.service';
import { AuditModule } from '../audit/audit.module';
import { PrismaService } from '../prisma.service';

@Module({
  imports: [
    // AuditModule exposes AuditService, which ReservesService uses to emit
    // immutable audit events on every reserve write (ADR-002).
    AuditModule,
  ],
  controllers: [
    ReservesController,
  ],
  providers: [
    // Core reserves business logic: proposal, approval tiers, history.
    ReservesService,

    // JFSA threshold detection — emits NotificationToRegulator records
    // for reserve changes crossing ¥100M (ADR-006).
    ReservesJfsaService,

    // IFRS17-ready reserve aggregation export for the actuarial pipeline.
    ReservesExportService,

    // PrismaService is referenced directly here so that if the global
    // Prisma module is not marked @Global(), this module still compiles.
    // Consistent with Phase 1 / sibling module conventions.
    PrismaService,
  ],
  exports: [
    // Export ReservesService so that other modules (e.g. AppiModule for
    // data-subject-export, ClaimsModule for reserve history lookups) can
    // inject it without re-declaring it.
    ReservesService,

    // Export ReservesJfsaService in case the Audit or APPI modules need
    // to surface JFSA notification records directly.
    ReservesJfsaService,

    // Export ReservesExportService for use in integration tests and any
    // future scheduled-job module (Track B daily JFSA batch flush).
    ReservesExportService,
  ],
})
export class ReservesModule {}