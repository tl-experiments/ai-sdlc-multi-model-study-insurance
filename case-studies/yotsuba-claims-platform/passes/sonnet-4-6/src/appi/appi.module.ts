// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/appi/appi.module.ts
//
// APPI compliance module — wires together the data-subject export and PII
// anonymisation concerns (APPI Articles 28 and 36).
//
// Design reference: design.md §3 Module structure (appi/appi.module.ts)
// Brief reference:  brief.md §1 APPI compliance hooks
//
// Module responsibilities:
//   - Register AppiService for data-subject export and anonymisation.
//   - Import PrismaModule (via PrismaService) for direct DB access.
//   - Import AuditModule so AppiService can emit immutable AuditEvents
//     on every export and anonymisation write (ADR-002).
//
// This module does NOT declare a controller — the APPI endpoints
// (GET /claims/:id/data-subject-export and
//  DELETE /claims/:id/personal-data-anonymise) are mounted on the
// ClaimsController to keep the /claims/:id resource coherent. The
// ClaimsModule imports AppiModule so it can inject AppiService.
// =============================================================================

import { Module } from '@nestjs/common';
import { AppiService } from './appi.service';
import { AuditModule } from '../audit/audit.module';
import { PrismaService } from '../prisma.service';

@Module({
  imports: [
    // AuditModule exposes AuditService — every APPI write must emit an
    // immutable AuditEvent (ADR-002). AuditModule is expected to export
    // AuditService so it is injectable here.
    AuditModule,
  ],
  providers: [
    // PrismaService is provided directly here rather than via a shared
    // PrismaModule import so that AppiModule stays self-contained and
    // can be imported by ClaimsModule without circular dependency concerns.
    PrismaService,

    // Core APPI compliance service: data-subject-export + anonymise.
    AppiService,
  ],
  exports: [
    // Export AppiService so ClaimsModule (and any other module that needs
    // to trigger APPI compliance operations) can inject it without
    // re-providing it.
    AppiService,
  ],
})
export class AppiModule {}