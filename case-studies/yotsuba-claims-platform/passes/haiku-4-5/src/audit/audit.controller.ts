import {
  Controller,
  Get,
  UseGuards,
  Query,
  ParseIntPipe,
  DefaultValue,
} from '@nestjs/common';
import { AuditService } from './audit.service';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles } from '../common/roles.decorator';
import { CurrentUser } from '../common/current-user.decorator';
import { UserRole } from '@prisma/client';

/**
 * Audit controller for Yotsuba Claims Platform.
 *
 * Provides read-only access to the immutable audit log.
 * Only auditors can access this endpoint; all other roles are denied.
 *
 * The audit log captures every write operation across the platform:
 * - Claim creation, status transitions, note additions, evidence uploads
 * - Reserve proposals, approvals, rejections
 * - User assignments and reassignments
 * - Data exports and anonymisations
 *
 * Each AuditEvent includes actor, action, claim_id, payload_hash, request_id,
 * and correlation_id, enabling full reconstruction of any operation's chain.
 *
 * Usage:
 *   GET /audit?from=2024-01-01&to=2024-01-31&actor=user-123&claim_id=claim-456&action=claim.created&limit=50&offset=0
 *   → Returns paginated AuditEvent records matching filters, ordered by timestamp descending
 */
@Controller('audit')
@UseGuards(JwtAuthGuard, RolesGuard)
@Roles(UserRole.auditor)
export class AuditController {
  constructor(private readonly auditService: AuditService) {}

  /**
   * Retrieve audit events with optional filtering and pagination.
   *
   * Supports filtering by:
   *   - actor_id: User ID of the actor who performed the action
   *   - claim_id: Claim ID associated with the event
   *   - action: Action type (e.g., 'claim.created', 'reserve.approved')
   *   - from: Start of date range (ISO 8601 string)
   *   - to: End of date range (ISO 8601 string)
   *
   * Results are ordered by timestamp descending (most recent first).
   * Pagination is supported via limit and offset query parameters.
   *
   * @param actor_id Optional filter by actor user ID
   * @param claim_id Optional filter by claim ID
   * @param action Optional filter by action type
   * @param from Optional start date (ISO 8601)
   * @param to Optional end date (ISO 8601)
   * @param limit Maximum number of events to return (default 100, max 1000)
   * @param offset Pagination offset (default 0)
   * @param user The authenticated auditor (injected by JwtAuthGuard)
   * @returns Object containing total count and paginated array of AuditEvent records
   */
  @Get()
  async getAuditEvents(
    @Query('actor_id') actor_id?: string,
    @Query('claim_id') claim_id?: string,
    @Query('action') action?: string,
    @Query('from') from?: string,
    @Query('to') to?: string,
    @Query('limit', new DefaultValue(100), ParseIntPipe) limit: number = 100,
    @Query('offset', new DefaultValue(0), ParseIntPipe) offset: number = 0,
    @CurrentUser() user?: { id: string; role: UserRole },
  ) {
    // Enforce reasonable pagination limits
    const safeLimit = Math.min(Math.max(limit, 1), 1000);
    const safeOffset = Math.max(offset, 0);

    // Build filter object
    const filters: any = {};
    if (actor_id) {
      filters.actor_id = actor_id;
    }
    if (claim_id) {
      filters.claim_id = claim_id;
    }
    if (action) {
      filters.action = action;
    }
    if (from) {
      filters.from = new Date(from);
    }
    if (to) {
      filters.to = new Date(to);
    }

    // Fetch events and total count in parallel
    const [events, total] = await Promise.all([
      this.auditService.getEvents(filters, safeLimit, safeOffset),
      this.auditService.countEvents(filters),
    ]);

    return {
      total,
      limit: safeLimit,
      offset: safeOffset,
      data: events,
    };
  }
}