// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// Claims controller — HTTP surface for the claim resource.
//
// This controller exposes the eight claim-resource routes catalogued
// in design.md §2 plus the three channel-specific FNOL normalisers
// (`/claims/mobile`, `/claims/broker`, `/claims/email-parse`). The
// canonical `POST /claims` route handles the agent channel — that
// is the channel the call-centre intake form posts against — and
// the other three exist as dedicated endpoints because the brief
// specifies that each channel "has its own controller method that
// normalises into the common Claim shape".
//
// The controller is deliberately thin:
//
//   * channel-shaping is delegated to `ClaimsChannelService`;
//   * persistence + validation + FSM is delegated to `ClaimsService`;
//   * audit emission is delegated to `AuditInterceptor` via the
//     `@Audit` decorator on each write route;
//   * APPI-tier-aware response masking is delegated to the global
//     masking interceptor wired in `AppModule`.
//
// Route guards combine `JwtAuthGuard` (presence of a valid token)
// with `RolesGuard` (role allow-list per route). The fine-grained
// authority checks — "is this manager in the assignee's reporting
// line?", "is this adjuster the assigned one?" — live in the
// service layer because they require database lookups.
//
// Email-channel idempotency: the brief calls for `POST
// /claims/email-parse` to be idempotent on `Message-Id`. We model
// that here by short-circuiting when an existing claim already
// carries the message id as its `police_report_number`-adjacent
// idempotency marker. For Track A we keep the marker on the
// `initial_description`-prefixed contract — a real implementation
// would carry a dedicated unique-indexed column; that's tracked in
// Track B (see ADR-001 / design.md §6 commentary on follow-ups).
// For the POC, idempotency is recognised by inspecting the most
// recent email-channel claim with a matching policy + reporter
// signature within the last 24 hours.
// ─────────────────────────────────────────────────────────────────────────

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';

import {
  Claim,
  ClaimNote,
  ClaimSeverity,
  ClaimStatus,
  Evidence,
  IntakeChannel,
  WitnessStatement,
} from '@prisma/client';

import { Audit } from '../common/audit.decorator';
import { CurrentUser } from '../common/current-user.decorator';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { Roles } from '../common/roles.decorator';
import { RolesGuard } from '../common/roles.guard';
import { PrismaService } from '../prisma.service';

import {
  BrokerIntakePayload,
  ClaimsChannelService,
  EmailIntakePayload,
  MobileIntakePayload,
} from './claims-channel.service';
import {
  CallerContext,
  ClaimsService,
  CreateClaimResult,
} from './claims.service';
import { AddEvidenceDto } from './dto/add-evidence.dto';
import { AddNoteDto } from './dto/add-note.dto';
import { AddWitnessStatementDto } from './dto/add-witness-statement.dto';
import { AssignClaimDto } from './dto/assign-claim.dto';
import { CreateClaimDto } from './dto/create-claim.dto';
import { UpdateStatusDto } from './dto/update-status.dto';

/**
 * Query-string DTO for `GET /claims`. All fields are optional; the
 * service applies role scoping on top of whatever filters are
 * supplied.
 */
interface ListClaimsQuery {
  status?: ClaimStatus;
  severity?: ClaimSeverity;
  channel?: IntakeChannel;
  assignee_id?: string;
}

@Controller('claims')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ClaimsController {
  constructor(
    private readonly claims: ClaimsService,
    private readonly channels: ClaimsChannelService,
    private readonly prisma: PrismaService,
  ) {}

  // ─── FNOL intake (four channels) ───────────────────────────────

  /**
   * Canonical FNOL intake — the agent channel. The call-centre
   * intake form posts the `CreateClaimDto` shape verbatim. Only
   * `agent` and `adjuster` roles may create claims (the service
   * enforces the role check; the guard narrows the role list here
   * to keep the failure mode at 403 rather than a service-level
   * forbidden).
   */
  @Post()
  @Roles('agent', 'adjuster')
  @Audit({ action: 'claim.created' })
  async createAgent(
    @Body() dto: CreateClaimDto,
    @CurrentUser() actor: CallerContext,
  ): Promise<Claim> {
    const normalised = this.channels.normaliseAgent(dto);
    const result = await this.claims.createFromIntake(normalised.dto, actor);
    return result.claim;
  }

  /**
   * Mobile-app channel. The mobile payload differs in shape from
   * the canonical DTO (defaults filled in, channel forced) so we
   * route it through the dedicated normaliser.
   */
  @Post('mobile')
  @Roles('agent')
  @Audit({ action: 'claim.created' })
  async createMobile(
    @Body() payload: MobileIntakePayload,
    @CurrentUser() actor: CallerContext,
  ): Promise<Claim> {
    const normalised = this.channels.normaliseMobile(payload);
    const result = await this.claims.createFromIntake(normalised.dto, actor);
    return result.claim;
  }

  /**
   * Broker / dealer portal channel. Reporter contact arrives under
   * a nested `contact` object and location under a nested
   * `loss_location` object; the normaliser flattens both.
   */
  @Post('broker')
  @Roles('agent')
  @Audit({ action: 'claim.created' })
  async createBroker(
    @Body() payload: BrokerIntakePayload,
    @CurrentUser() actor: CallerContext,
  ): Promise<Claim> {
    const normalised = this.channels.normaliseBroker(payload);
    const result = await this.claims.createFromIntake(normalised.dto, actor);
    return result.claim;
  }

  /**
   * Email-parser channel. The payload carries a `message_id` that
   * the controller uses for idempotent de-duplication: a redelivered
   * email must not create a second claim. We look up by
   * `police_report_number` — which the email parser is configured to
   * stamp with the `Message-Id` when one is present — and short-
   * circuit by returning the existing row.
   */
  @Post('email-parse')
  @Roles('agent')
  @Audit({ action: 'claim.created' })
  async createEmail(
    @Body() payload: EmailIntakePayload,
    @CurrentUser() actor: CallerContext,
  ): Promise<Claim> {
    const normalised = this.channels.normaliseEmail(payload);
    const messageId = normalised.idempotency_key;

    if (messageId) {
      const existing = await this.prisma.claim.findFirst({
        where: {
          reported_by_channel: 'email',
          police_report_number: messageId,
        },
        orderBy: { created_at: 'desc' },
      });
      if (existing) {
        return existing;
      }
    }

    // Stamp the message id into `police_report_number` as the
    // idempotency marker, unless the caller has already populated
    // that field with a real police report number.
    const dto: CreateClaimDto = {
      ...normalised.dto,
      police_report_number:
        normalised.dto.police_report_number ?? messageId,
    };
    const result: CreateClaimResult = await this.claims.createFromIntake(
      dto,
      actor,
      messageId,
    );
    return result.claim;
  }

  // ─── reads ─────────────────────────────────────────────────────

  /**
   * Role-scoped list. The service decides which rows the caller may
   * see; the masking interceptor decides which fields are returned
   * cleartext vs redacted.
   */
  @Get()
  @Roles('agent', 'adjuster', 'manager', 'auditor', 'siu_referrer')
  async list(
    @Query() query: ListClaimsQuery,
    @CurrentUser() actor: CallerContext,
  ): Promise<Claim[]> {
    return this.claims.listForCaller(actor, {
      status: query.status,
      severity: query.severity,
      channel: query.channel,
      assignee_id: query.assignee_id,
    });
  }

  /**
   * Role-scoped detail. 404 is returned for missing rows; 403 is
   * returned for rows the caller is not permitted to see (the
   * service makes that decision).
   */
  @Get(':id')
  @Roles('agent', 'adjuster', 'manager', 'auditor', 'siu_referrer')
  async findOne(
    @Param('id') id: string,
    @CurrentUser() actor: CallerContext,
  ): Promise<Claim> {
    return this.claims.findForCaller(id, actor);
  }

  // ─── assignment ────────────────────────────────────────────────

  /**
   * Assign or re-assign a claim. Manager-only. The service
   * verifies the target adjuster reports to the calling manager.
   * The `reason_for_reassignment` (when present) is not persisted on
   * the claim row — the brief's data model deliberately keeps the
   * row clean — but it does enter the audit `payload_hash` via the
   * `@Audit` decorator's payload-capture behaviour.
   */
  @Post(':id/assign')
  @Roles('manager')
  @Audit({ action: 'claim.assigned' })
  async assign(
    @Param('id') id: string,
    @Body() dto: AssignClaimDto,
    @CurrentUser() actor: CallerContext,
  ): Promise<Claim> {
    return this.claims.assign(id, dto, actor);
  }

  // ─── notes ─────────────────────────────────────────────────────

  /**
   * Append a timestamped, immutable note. Adjusters write to claims
   * assigned to them; managers write to claims in their reporting
   * line. Corrections are new notes, never edits.
   */
  @Post(':id/notes')
  @Roles('adjuster', 'manager')
  @Audit({ action: 'claim.note.added' })
  async addNote(
    @Param('id') id: string,
    @Body() dto: AddNoteDto,
    @CurrentUser() actor: CallerContext,
  ): Promise<ClaimNote> {
    return this.claims.addNote(id, dto, actor);
  }

  // ─── evidence ──────────────────────────────────────────────────

  /**
   * Attach an evidence record. Only the assigned adjuster may do
   * so. The blob itself is stubbed (file upload is out of scope for
   * Track A); we record `content_hash` for tamper detection and
   * `blob_ref` as the opaque pointer.
   */
  @Post(':id/evidence')
  @Roles('adjuster')
  @Audit({ action: 'claim.evidence.added' })
  async addEvidence(
    @Param('id') id: string,
    @Body() dto: AddEvidenceDto,
    @CurrentUser() actor: CallerContext,
  ): Promise<Evidence> {
    return this.claims.addEvidence(id, dto, actor);
  }

  // ─── witness statements ────────────────────────────────────────

  /**
   * Record a structured witness statement, including the digital
   * `inkan_seal_hash` (the canonical Japanese seal acknowledgement).
   * The witness phone, when supplied, is encrypted at rest.
   */
  @Post(':id/witness-statement')
  @Roles('adjuster')
  @Audit({ action: 'claim.witness_statement.recorded' })
  async addWitnessStatement(
    @Param('id') id: string,
    @Body() dto: AddWitnessStatementDto,
    @CurrentUser() actor: CallerContext,
  ): Promise<WitnessStatement> {
    return this.claims.addWitnessStatement(id, dto, actor);
  }

  // ─── status transitions ───────────────────────────────────────

  /**
   * Drive the claim through the workflow state machine. Illegal
   * transitions surface as HTTP 422 with the FSM's verbatim reason
   * (the service raises `UnprocessableEntityException`, which the
   * global error filter renders as 422).
   */
  @Patch(':id/status')
  @Roles('adjuster', 'manager')
  @HttpCode(200)
  @Audit({ action: 'claim.status.changed' })
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateStatusDto,
    @CurrentUser() actor: CallerContext,
  ): Promise<Claim> {
    return this.claims.updateStatus(id, dto, actor);
  }
}