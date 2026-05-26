import { Module } from '@nestjs/common';
import { AuditService } from './audit.service';
import { AuditController } from './audit.controller';
import { PrismaService } from '../prisma.service';

/**
 * Audit module for Yotsuba Claims Platform.
 *
 * Provides immutable audit logging and retrieval across the entire platform.
 * Every write operation (claim creation, note addition, reserve approval, etc.)
 * emits an AuditEvent that is captured and stored append-only.
 *
 * The audit log is the source of truth for regulatory compliance and
 * tamper-evident audit trails. No UPDATE or DELETE paths exist in code;
 * this is enforced by convention and documented in ADR-002.
 *
 * Exports:
 *   - AuditService: Core audit logging and retrieval logic
 *   - AuditController: HTTP endpoints for audit log access (auditor-only)
 *
 * Dependencies:
 *   - PrismaService: Database access
 */
@Module({
  providers: [AuditService, PrismaService],
  controllers: [AuditController],
  exports: [AuditService],
})
export class AuditModule {}