// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// Audit controller.
//
// Exposes the single read endpoint declared in design.md §2:
//   * `GET /audit` — auditor-only; returns audit events filtered by
//                    `from`, `to`, `actor`, `claim_id`, `action`.
//
// Design notes:
//   * The audit log is append-only (ADR-002). This controller exposes
//     no write routes; appends happen via `AuditService.record` driven
//     by the `AuditInterceptor` and a small number of service-internal
//     callers (notably the JFSA threshold emitter). A grep of this
//     file for `Post`, `Put`, `Patch`, `Delete` should return nothing.
//   * Only `auditor` role can read the log. The brief's role matrix is
//     explicit: managers do not see other managers' audit trails, and
//     adjusters never see audit data at all. APPI Article 28 disclosure
//     to data subjects goes through `appi.service.ts`, not here.
//   * Query parameters are parsed with explicit type coercion: dates
//     are ISO-8601 strings on the wire, `limit` is an integer string,
//     and the cursor is an opaque event id. We validate dates here
//     (rather than via a DTO) because Nest's query-DTO ergonomics for
//     optional date/number fields are noisy; the validation we need is
//     small and local.
// ─────────────────────────────────────────────────────────────────────────

import {
  BadRequestException,
  Controller,
  Get,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOkResponse,
  ApiOperation,
  ApiQuery,
  ApiTags,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';

import type { AuditEvent } from '@prisma/client';

import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { Roles } from '../common/roles.decorator';
import { RolesGuard } from '../common/roles.guard';

import { AuditService, type AuditQuery } from './audit.service';

@ApiTags('audit')
@ApiBearerAuth()
@Controller('audit')
@UseGuards(JwtAuthGuard, RolesGuard)
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  /**
   * List audit events with optional filters. Auditor-only.
   *
   * Filters are AND-combined. Results are newest-first; pagination is
   * cursor-based on the audit event `id` (returned in the last row of
   * the previous page).
   */
  @Get()
  @Roles('auditor')
  @ApiOperation({
    summary: 'List audit events (auditor-only).',
    description:
      'Returns audit events filtered by the supplied query parameters, '
      + 'newest-first. The audit log is append-only; this endpoint is the '
      + 'sole supported read pathway. Pagination is cursor-based: pass '
      + 'the `id` of the last event from the previous page as `cursor`.',
  })
  @ApiQuery({
    name: 'from',
    required: false,
    description: 'ISO-8601 lower bound on `ts` (inclusive).',
  })
  @ApiQuery({
    name: 'to',
    required: false,
    description: 'ISO-8601 upper bound on `ts` (inclusive).',
  })
  @ApiQuery({
    name: 'actor',
    required: false,
    description: 'Filter by `actor_id`.',
  })
  @ApiQuery({
    name: 'claim_id',
    required: false,
    description: 'Filter by `claim_id`.',
  })
  @ApiQuery({
    name: 'action',
    required: false,
    description: 'Filter by action string, e.g. `claim.created`.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    description: 'Page size (default 100, max 500).',
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    description: 'Audit event `id` to resume from (exclusive).',
  })
  @ApiOkResponse({ description: 'Filtered audit event page.' })
  @ApiUnauthorizedResponse({
    description: 'Missing/invalid token or non-auditor caller.',
  })
  async list(
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('actor') actor?: string,
    @Query('claim_id') claimId?: string,
    @Query('action') action?: string,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ): Promise<AuditEvent[]> {
    const filter: AuditQuery = {};

    if (from !== undefined) {
      filter.from = this.parseDate(from, 'from');
    }
    if (to !== undefined) {
      filter.to = this.parseDate(to, 'to');
    }
    if (filter.from && filter.to && filter.from > filter.to) {
      throw new BadRequestException('`from` must be <= `to`.');
    }
    if (actor !== undefined && actor !== '') {
      filter.actor = actor;
    }
    if (claimId !== undefined && claimId !== '') {
      filter.claim_id = claimId;
    }
    if (action !== undefined && action !== '') {
      filter.action = action;
    }
    if (limit !== undefined) {
      filter.limit = this.parseLimit(limit);
    }
    if (cursor !== undefined && cursor !== '') {
      filter.cursor = cursor;
    }

    return this.auditService.query(filter);
  }

  // ─── helpers ───────────────────────────────────────────────────────

  private parseDate(raw: string, field: string): Date {
    const d = new Date(raw);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException(
        `Query parameter \`${field}\` is not a valid ISO-8601 date.`,
      );
    }
    return d;
  }

  private parseLimit(raw: string): number {
    const n = Number.parseInt(raw, 10);
    if (!Number.isFinite(n) || n <= 0) {
      throw new BadRequestException(
        'Query parameter `limit` must be a positive integer.',
      );
    }
    return n;
  }
}