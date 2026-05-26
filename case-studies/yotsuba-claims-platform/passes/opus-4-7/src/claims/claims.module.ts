// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// Claims module — wires the claim-resource HTTP surface together.
//
// Per design.md §3, the claims module owns:
//
//   * `ClaimsController` — the eight claim-resource routes plus
//     the three channel-specific FNOL normalisers;
//   * `ClaimsService` — the spine that handles intake, reads,
//     assignment, notes, evidence, witness statements, and status
//     transitions;
//   * `ClaimsChannelService` — the pure channel-shaping layer that
//     converts per-channel intake payloads into the canonical
//     `CreateClaimDto`.
//
// The FSM (`claims-status.fsm.ts`) is intentionally not registered
// as a provider: it is a pure function module imported directly by
// `ClaimsService`, which keeps the workflow logic side-effect-free
// and trivially unit-testable without the Nest container.
//
// `PrismaService` is imported here as a provider rather than from
// a global module so that the claims module is self-contained for
// tests that bootstrap it in isolation. `AppModule` is free to
// declare `PrismaService` once at the top level; Nest's DI will
// reuse the single instance regardless.
//
// The reserves, audit, and APPI modules consume `ClaimsService`
// indirectly (through their own service layers + the shared Prisma
// client), so we re-export it here for consumers that import the
// module.
// ─────────────────────────────────────────────────────────────────────────

import { Module } from '@nestjs/common';

import { PrismaService } from '../prisma.service';

import { ClaimsChannelService } from './claims-channel.service';
import { ClaimsController } from './claims.controller';
import { ClaimsService } from './claims.service';

@Module({
  controllers: [ClaimsController],
  providers: [ClaimsService, ClaimsChannelService, PrismaService],
  exports: [ClaimsService, ClaimsChannelService],
})
export class ClaimsModule {}