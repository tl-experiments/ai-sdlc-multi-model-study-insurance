import { Module } from '@nestjs/common';
import { ReservesController } from './reserves.controller';
import { ReservesService } from './reserves.service';
import { ReservesExportService } from './reserves-export.service';
import { ReservesJfsaService } from './reserves-jfsa.service';
import { PrismaService } from '../prisma.service';

/**
 * ReservesModule
 *
 * Encapsulates reserve proposal, approval, rejection, and export workflows.
 * Reserves are money set aside against expected payout; reserve adequacy is
 * regulated and reported to JFSA and in IFRS17 disclosures.
 *
 * Exports:
 *   - ReservesService: core business logic for reserve lifecycle
 *   - ReservesExportService: IFRS17-ready aggregation and export
 *   - ReservesJfsaService: JFSA threshold detection and notification
 *   - ReservesController: HTTP endpoints
 *
 * Dependencies:
 *   - PrismaService: database access
 *
 * Approval workflow:
 *   - Adjuster proposes reserve with category, amount, justification
 *   - System checks approval tier:
 *     * ≤¥1M: auto-approved
 *     * ¥1M–¥10M: manager approval required
 *     * >¥10M: manager + claims_director approval required
 *   - Manager reviews and approves (≤¥10M) or rejects
 *   - If >¥10M, manager approval routes to claims_director for final approval
 *   - Once approved, JFSA threshold check emits notification if crossed ¥100M
 *   - Rejected proposals cannot be re-approved; new proposal must be created
 *
 * Audit:
 *   - Every reserve action (propose, approve, reject) emits AuditEvent
 *   - Payload hash binds the event to the reserve state
 *   - Audit interceptor captures these via @Audit decorator on controller
 *
 * IFRS17 export:
 *   - ReservesExportService aggregates approved reserves by category
 *   - Exports in tabular JSON format suitable for downstream IFRS17 calculation
 *   - Supports period-based and claim-based aggregation
 *
 * JFSA notification:
 *   - ReservesJfsaService detects when reserves cross ¥100M threshold
 *   - Emits NotificationToRegulator records for daily batch flush
 *   - POC captures event shape; actual JFSA wire format is Track B
 */
@Module({
  controllers: [ReservesController],
  providers: [
    ReservesService,
    ReservesExportService,
    ReservesJfsaService,
    PrismaService,
  ],
  exports: [
    ReservesService,
    ReservesExportService,
    ReservesJfsaService,
  ],
})
export class ReservesModule {}