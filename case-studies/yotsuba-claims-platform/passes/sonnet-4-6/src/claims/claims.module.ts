// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/claims/claims.module.ts
//
// Claims NestJS module — wires together the FNOL intake, adjuster workbench,
// and APPI compliance endpoints for the claims resource.
//
// Design reference: design.md §3 Module structure
// Brief reference:  brief.md §1 FNOL, §2 Adjuster Workbench
//
// Module responsibilities:
//   - Declare ClaimsController (all claim routes)
//   - Provide ClaimsService (core business logic)
//   - Provide ClaimsChannelService (channel-specific normalisation)
//   - Import AuditModule so ClaimsService can emit AuditEvents
//   - Import PrismaService via global provision (registered in AppModule)
//
// AuditModule is imported here because ClaimsService calls AuditService
// directly for every write operation (FNOL create, note, evidence, status
// transition, etc.). PrismaService is expected to be globally available
// (registered in AppModule as a global provider).
// =============================================================================

import { Module } from '@nestjs/common';

import { AuditModule } from '../audit/audit.module';
import { ClaimsController } from './claims.controller';
import { ClaimsService } from './claims.service';
import { ClaimsChannelService } from './claims-channel.service';

@Module({
  imports: [
    // AuditModule exports AuditService, which ClaimsService injects to emit
    // immutable AuditEvent rows on every write operation (ADR-002).
    AuditModule,
  ],
  controllers: [
    // All claim resource routes: FNOL intake (4 channels), adjuster workbench
    // operations, and APPI compliance endpoints.
    ClaimsController,
  ],
  providers: [
    // Core claims business logic: severity classification, status FSM,
    // PII encryption, role-based access enforcement.
    ClaimsService,

    // Channel-specific intake normalisation: agent, mobile, broker, email.
    // Handles APPI consent enforcement and email idempotency checks.
    ClaimsChannelService,
  ],
  exports: [
    // Export ClaimsService so other modules (e.g. AppiModule, ReservesModule)
    // can access claim data and APPI operations without circular dependencies.
    ClaimsService,
  ],
})
export class ClaimsModule {}