// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// APPI module — wires the APPI-compliance hooks (data-subject
// export under Article 28, anonymisation under the right to
// erasure) into the Nest container.
//
// The module is intentionally thin: it owns the `AppiService`
// aggregator and exports it so the claims controller can
// delegate the `GET /claims/:id/data-subject-export` and
// `DELETE /claims/:id/personal-data-anonymise` routes through
// to it. We deliberately do *not* register a separate APPI
// controller in Track A — the brief.md API contract attaches
// both APPI routes to the claim resource path, and the
// claims controller is the canonical owner of that surface.
//
// Dependencies:
//   * PrismaService — read claims/witness statements,
//                     write the anonymise audit event.
//
// The `common/encryption.ts` helpers used by the service are
// pure functions imported directly, so they need no provider
// registration here.
// ─────────────────────────────────────────────────────────────────────────

import { Module } from '@nestjs/common';

import { PrismaService } from '../prisma.service';
import { AppiService } from './appi.service';

@Module({
  providers: [AppiService, PrismaService],
  exports: [AppiService],
})
export class AppiModule {}