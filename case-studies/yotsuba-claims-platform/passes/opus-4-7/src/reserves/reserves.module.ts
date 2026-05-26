// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// Reserves module — wires the controller, service, JFSA producer,
// and IFRS17 export aggregator into a single Nest module.
//
// The reserves module is the actuarial-touching layer of the
// claims spine (brief.md Module 3). It depends on `PrismaService`
// (provided globally by `AppModule` via `PrismaModule`) and on
// the audit interceptor wired at the app level — no provider
// indirection is needed here.
//
// Three providers are exposed:
//   * `ReservesService`        — the approval-lifecycle orchestrator;
//   * `ReservesJfsaService`    — the JFSA threshold notification
//                                producer (¥100M trigger);
//   * `ReservesExportService`  — the IFRS17 monthly aggregator.
//
// `ReservesService` is exported so the seed script and any
// downstream module (Track B subrogation / SIU referral) can
// reach into the reserves API without re-instantiating Prisma.
// ─────────────────────────────────────────────────────────────────────────

import { Module } from '@nestjs/common';

import { PrismaService } from '../prisma.service';
import { ReservesController } from './reserves.controller';
import { ReservesExportService } from './reserves-export.service';
import { ReservesJfsaService } from './reserves-jfsa.service';
import { ReservesService } from './reserves.service';

@Module({
  controllers: [ReservesController],
  providers: [
    PrismaService,
    ReservesService,
    ReservesJfsaService,
    ReservesExportService,
  ],
  exports: [ReservesService, ReservesJfsaService, ReservesExportService],
})
export class ReservesModule {}