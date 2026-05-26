import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma.service';
import { AuditEvent, UserRole } from '@prisma/client';
import { createHash } from 'crypto';

/**
 * Audit service for Yotsuba Claims Platform.
 *
 * Handles creation and retrieval of immutable audit events.
 * Every write operation (claim creation, note addition, reserve approval, etc.)
 * emits an AuditEvent with actor, action, claim_id, payload_hash, request_id, and correlation_id.
 *
 * The audit log is append-only; no UPDATE or DELETE paths exist in code.
 * This ensures regulatory compliance and tamper-evident audit trails.
 *
 * Usage:
 *   await auditService.logEvent({
 *     actor_id: user.id,
 *     actor_role: user.role,
 *     action: 'claim.created',
 *     claim_id: claim.id,
 *     payload_hash: hashPayload(claim),
 *     request_id: req.id,
 *     correlation_id: req.correlation_id,
 *   });
 */
@Injectable()
export class AuditService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Log an audit event.
   *
   * Creates an immutable AuditEvent record. All parameters are required;
   * the event is timestamped at creation and cannot be modified.
   *
   * @param event Audit event details (actor_id, actor_role, action, claim_id, payload_hash, request_id, correlation_id)
   * @returns The created AuditEvent
   */
  async logEvent(event: {
    actor_id: string;
    actor_role: UserRole;
    action: string;
    claim_id?: string;
    target_id?: string;
    payload_hash: string;
    request_id: string;
    correlation_id: string;
  }): Promise<AuditEvent> {
    return this.prisma.auditEvent.create({
      data: {
        actor_id: event.actor_id,
        actor_role: event.actor_role,
        action: event.action,
        claim_id: event.claim_id,
        target_id: event.target_id,
        payload_hash: event.payload_hash,
        request_id: event.request_id,
        correlation_id: event.correlation_id,
      },
    });
  }

  /**
   * Retrieve audit events with optional filtering.
   *
   * Supports filtering by actor_id, claim_id, action, and date range.
   * Results are ordered by timestamp descending (most recent first).
   *
   * @param filters Optional filter criteria (actor_id, claim_id, action, from, to)
   * @param limit Maximum number of events to return (default 100)
   * @param offset Pagination offset (default 0)
   * @returns Array of AuditEvent records matching the filters
   */
  async getEvents(filters?: {
    actor_id?: string;
    claim_id?: string;
    action?: string;
    from?: Date;
    to?: Date;
  }, limit: number = 100, offset: number = 0): Promise<AuditEvent[]> {
    const where: any = {};

    if (filters?.actor_id) {
      where.actor_id = filters.actor_id;
    }
    if (filters?.claim_id) {
      where.claim_id = filters.claim_id;
    }
    if (filters?.action) {
      where.action = filters.action;
    }
    if (filters?.from || filters?.to) {
      where.ts = {};
      if (filters.from) {
        where.ts.gte = filters.from;
      }
      if (filters.to) {
        where.ts.lte = filters.to;
      }
    }

    return this.prisma.auditEvent.findMany({
      where,
      orderBy: { ts: 'desc' },
      take: limit,
      skip: offset,
    });
  }

  /**
   * Count audit events matching optional filters.
   *
   * Useful for pagination and reporting.
   *
   * @param filters Optional filter criteria (actor_id, claim_id, action, from, to)
   * @returns Total count of matching events
   */
  async countEvents(filters?: {
    actor_id?: string;
    claim_id?: string;
    action?: string;
    from?: Date;
    to?: Date;
  }): Promise<number> {
    const where: any = {};

    if (filters?.actor_id) {
      where.actor_id = filters.actor_id;
    }
    if (filters?.claim_id) {
      where.claim_id = filters.claim_id;
    }
    if (filters?.action) {
      where.action = filters.action;
    }
    if (filters?.from || filters?.to) {
      where.ts = {};
      if (filters.from) {
        where.ts.gte = filters.from;
      }
      if (filters.to) {
        where.ts.lte = filters.to;
      }
    }

    return this.prisma.auditEvent.count({ where });
  }

  /**
   * Compute SHA-256 hash of a payload.
   *
   * Used to bind audit events to their original request payloads.
   * The hash is stored in the AuditEvent; the original payload is not.
   *
   * @param payload The object to hash (typically normalized to JSON)
   * @returns Hex-encoded SHA-256 hash
   */
  hashPayload(payload: any): string {
    const normalized = JSON.stringify(payload, Object.keys(payload).sort());
    return createHash('sha256').update(normalized).digest('hex');
  }

  /**
   * Retrieve all audit events for a specific claim.
   *
   * Useful for claim timeline reconstruction and compliance audits.
   *
   * @param claim_id The claim ID to query
   * @returns Array of AuditEvent records for the claim, ordered by timestamp descending
   */
  async getClaimAuditTrail(claim_id: string): Promise<AuditEvent[]> {
    return this.prisma.auditEvent.findMany({
      where: { claim_id },
      orderBy: { ts: 'desc' },
    });
  }

  /**
   * Retrieve all audit events for a specific actor.
   *
   * Useful for user activity reports and compliance audits.
   *
   * @param actor_id The user ID to query
   * @param limit Maximum number of events to return (default 100)
   * @returns Array of AuditEvent records for the actor, ordered by timestamp descending
   */
  async getActorAuditTrail(actor_id: string, limit: number = 100): Promise<AuditEvent[]> {
    return this.prisma.auditEvent.findMany({
      where: { actor_id },
      orderBy: { ts: 'desc' },
      take: limit,
    });
  }
}