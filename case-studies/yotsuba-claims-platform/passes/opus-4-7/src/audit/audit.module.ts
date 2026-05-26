// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// Audit module.
//
// Wires the audit subsystem: the `AuditService` (single writer to the
// append-only `AuditEvent` table) and the `AuditController` (the
// auditor-only `GET /audit` read endpoint).
//
// Exported surface:
//   * `AuditService` — re-exported so other feature modules
//     (`ClaimsModule`, `ReservesModule`, `AppiModule`) can inject it
//     directly when they need to record service-internal events that
//     do not flow through the HTTP-layer `AuditInterceptor` (e.g. the
//     JFSA threshold emitter inside `reserves-jfsa.service.ts`, or the
//     APPI data-subject-export aggregator).
//
// Design notes:
//   * `PrismaService` is provided at the root (`AppModule`) and is
//     consumed here by injection; we deliberately do not re-provide it
//     locally so the singleton contract holds across modules.
//   * No write routes are exposed by the controller (ADR-002); the
//     module shape mirrors that contract — there is exactly one
//     controller and one provider.
// ─────────────────────────────────────────────────────────────────────────

import { Module } from '@nestjs/common';

import { AuditController } from './audit.controller';
import { AuditService } from './audit.service';

@Module({
  controllers: [AuditController],
  providers: [AuditService],
  exports: [AuditService],
})
export class AuditModule {}