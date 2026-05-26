import { Module } from '@nestjs/common';
import { ClaimsController } from './claims.controller';
import { ClaimsService } from './claims.service';
import { ClaimsChannelService } from './claims-channel.service';
import { PrismaService } from '../prisma.service';
import { EncryptionService } from '../common/encryption.service';

/**
 * Claims module.
 *
 * This module encapsulates all claim lifecycle management functionality,
 * from FNOL intake through investigation, reserve approval, settlement, and closure.
 *
 * Responsibilities:
 *   - FNOL intake from four channels (agent, mobile, broker, email)
 *   - Claim retrieval with role-based authorization and field masking
 *   - Claim assignment and reassignment
 *   - Immutable note, evidence, and witness statement recording
 *   - Claim status transitions via FSM
 *
 * Exports:
 *   - ClaimsController: HTTP endpoints for claim operations
 *   - ClaimsService: core business logic for claim lifecycle
 *   - ClaimsChannelService: channel-specific intake normalization
 *
 * Dependencies:
 *   - PrismaService: database access
 *   - EncryptionService: APPI special-care PII encryption
 *
 * Integration points:
 *   - ReservesModule: reserve proposal and approval (Track A)
 *   - AppiModule: data-subject-export and anonymization (Track A)
 *   - AuditModule: audit event emission via interceptor (Track A)
 */
@Module({
  controllers: [ClaimsController],
  providers: [ClaimsService, ClaimsChannelService, PrismaService, EncryptionService],
  exports: [ClaimsService, ClaimsChannelService],
})
export class ClaimsModule {}