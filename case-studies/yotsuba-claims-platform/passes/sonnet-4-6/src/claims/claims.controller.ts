// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/claims/claims.controller.ts
//
// Claims resource controller — FNOL intake, adjuster workbench, APPI endpoints.
//
// Design reference: design.md §2 API contract, §3 Module structure
// Brief reference:  brief.md §1 FNOL, §2 Adjuster Workbench
//
// Routes implemented:
//   POST   /claims                          — generic FNOL intake (channel dispatch)
//   POST   /claims/mobile                   — mobile channel normaliser
//   POST   /claims/broker                   — broker channel normaliser
//   POST   /claims/email-parse              — email parser channel (idempotent)
//   GET    /claims                          — role-scoped list with filters
//   GET    /claims/:id                      — role-masked detail
//   POST   /claims/:id/assign              — assign/re-assign adjuster (manager)
//   POST   /claims/:id/notes               — append-only note
//   POST   /claims/:id/evidence            — attach evidence
//   POST   /claims/:id/witness-statement   — structured witness intake
//   PATCH  /claims/:id/status              — FSM-guarded status transition
//   GET    /claims/:id/data-subject-export — APPI Article 28 disclosure
//   DELETE /claims/:id/personal-data-anonymise — APPI PII redaction
//
// Audit:
//   Every write emits an AuditEvent via ClaimsService (which calls AuditService).
//   The controller itself does not write audit events directly.
//
// PII masking:
//   ClaimsService.maskClaimForRole() is applied inside service methods before
//   returning to the controller. The controller is intentionally thin.
// =============================================================================

import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
  Req,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBearerAuth,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { ClaimSeverity, ClaimStatus, IntakeChannel, UserRole } from '@prisma/client';
import { Request } from 'express';

import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles } from '../common/roles.decorator';
import { CurrentUser } from '../common/current-user.decorator';

import { ClaimsService, CallerContext } from './claims.service';
import {
  ClaimsChannelService,
  AgentChannelPayload,
  MobileChannelPayload,
  BrokerChannelPayload,
  EmailChannelPayload,
} from './claims-channel.service';

import { CreateClaimDto } from './dto/create-claim.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { AssignClaimDto } from './dto/assign-claim.dto';
import { AddNoteDto } from './dto/add-note.dto';
import { AddEvidenceDto } from './dto/add-evidence.dto';
import { AddWitnessStatementDto } from './dto/add-witness-statement.dto';

// ---------------------------------------------------------------------------
// Authenticated user shape attached to request by JwtAuthGuard
// ---------------------------------------------------------------------------

interface AuthenticatedUser {
  id: string;
  role: UserRole;
  username: string;
  display_name: string;
  is_claims_director: boolean;
}

// ---------------------------------------------------------------------------
// Helper: build CallerContext from request + user
// ---------------------------------------------------------------------------

function buildCallerContext(
  user: AuthenticatedUser,
  req: Request,
): CallerContext {
  return {
    id: user.id,
    role: user.role,
    request_id: (req.headers['x-request-id'] as string) ?? 'unknown',
    correlation_id:
      (req.headers['x-correlation-id'] as string) ?? 'unknown',
  };
}

// ---------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------

@ApiTags('claims')
@ApiBearerAuth()
@UseGuards(JwtAuthGuard, RolesGuard)
@Controller('claims')
export class ClaimsController {
  constructor(
    private readonly claimsService: ClaimsService,
    private readonly channelService: ClaimsChannelService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // POST /claims/mobile — mobile channel normaliser
  // Must be declared before :id routes to avoid route collision.
  // ─────────────────────────────────────────────────────────────────────────

  @Post('mobile')
  @Roles(UserRole.agent, UserRole.adjuster, UserRole.manager)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Mobile-app channel FNOL intake',
    description:
      'Normalises a mobile-app channel payload and creates a new claim. ' +
      'APPI consent fields are mandatory for this channel.',
  })
  @ApiResponse({ status: 201, description: 'Claim created via mobile channel.' })
  @ApiResponse({ status: 400, description: 'Validation error or missing APPI consent.' })
  async createViaMobile(
    @Body() payload: MobileChannelPayload,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const caller = buildCallerContext(user, req);
    const result = this.channelService.normaliseMobilePayload(payload);
    return this.claimsService.create(result.dto, caller);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // POST /claims/broker — broker channel normaliser
  // ─────────────────────────────────────────────────────────────────────────

  @Post('broker')
  @Roles(UserRole.agent, UserRole.adjuster, UserRole.manager)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Broker/dealer portal channel FNOL intake',
    description:
      'Normalises a broker channel payload and creates a new claim. ' +
      'APPI consent fields are mandatory for this channel.',
  })
  @ApiResponse({ status: 201, description: 'Claim created via broker channel.' })
  @ApiResponse({ status: 400, description: 'Validation error or missing APPI consent.' })
  async createViaBroker(
    @Body() payload: BrokerChannelPayload,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const caller = buildCallerContext(user, req);
    const result = this.channelService.normaliseBrokerPayload(payload);
    return this.claimsService.create(result.dto, caller);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // POST /claims/email-parse — email parser channel (idempotent on Message-Id)
  // ─────────────────────────────────────────────────────────────────────────

  @Post('email-parse')
  @Roles(UserRole.agent, UserRole.adjuster, UserRole.manager)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Email-parser channel FNOL intake',
    description:
      'Normalises a parsed-email payload and creates a new claim. ' +
      'Idempotent on message_id — duplicate submissions return the existing claim. ' +
      'APPI consent fields are mandatory for this channel.',
  })
  @ApiResponse({ status: 201, description: 'Claim created or existing claim returned (idempotent).' })
  @ApiResponse({ status: 400, description: 'Validation error, missing message_id, or missing APPI consent.' })
  async createViaEmail(
    @Body() payload: EmailChannelPayload,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const caller = buildCallerContext(user, req);

    // correlation_id for email channel is the RFC 5322 Message-Id for
    // idempotency. Override the caller context so the audit event carries it.
    const emailCaller: CallerContext = {
      ...caller,
      correlation_id: payload.message_id ?? caller.correlation_id,
    };

    const result = await this.channelService.normaliseEmailPayload(payload);

    if (result.is_duplicate && result.existing_claim_id) {
      // Return the existing claim without creating a duplicate.
      return this.claimsService.findOne(result.existing_claim_id, emailCaller);
    }

    return this.claimsService.create(result.dto, emailCaller);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // POST /claims — generic FNOL intake (channel dispatch via body field)
  // ─────────────────────────────────────────────────────────────────────────

  @Post()
  @Roles(UserRole.agent, UserRole.adjuster, UserRole.manager)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Create a new FNOL claim (generic channel endpoint)',
    description:
      'Accepts a claim payload for any channel. ' +
      'The reported_by_channel field determines which normaliser is applied. ' +
      'For the email channel, use POST /claims/email-parse for idempotency support.',
  })
  @ApiResponse({ status: 201, description: 'Claim created.' })
  @ApiResponse({ status: 400, description: 'Validation error or missing APPI consent.' })
  async create(
    @Body() body: AgentChannelPayload & { reported_by_channel?: string },
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const caller = buildCallerContext(user, req);

    const rawChannel = body.reported_by_channel ?? IntakeChannel.agent;
    const channel = this.channelService.resolveChannel(String(rawChannel));

    let dto: CreateClaimDto;

    if (channel === IntakeChannel.email) {
      // Delegate to the async email normaliser.
      const emailPayload = body as unknown as EmailChannelPayload;
      const emailCaller: CallerContext = {
        ...caller,
        correlation_id: emailPayload.message_id ?? caller.correlation_id,
      };
      const result = await this.channelService.normaliseEmailPayload(emailPayload);
      if (result.is_duplicate && result.existing_claim_id) {
        return this.claimsService.findOne(result.existing_claim_id, emailCaller);
      }
      return this.claimsService.create(result.dto, emailCaller);
    }

    // Synchronous channels: agent, mobile, broker
    const result = this.channelService.normaliseSyncChannel(channel, body);
    dto = result.dto;

    return this.claimsService.create(dto, caller);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GET /claims — role-scoped list
  // ─────────────────────────────────────────────────────────────────────────

  @Get()
  @Roles(
    UserRole.agent,
    UserRole.adjuster,
    UserRole.manager,
    UserRole.auditor,
    UserRole.siu_referrer,
  )
  @ApiOperation({
    summary: 'List claims (role-scoped)',
    description:
      'Returns a paginated, role-scoped list of claims. ' +
      'Adjusters see only their assigned claims; managers/auditors see all.',
  })
  @ApiQuery({ name: 'status', required: false, enum: ClaimStatus })
  @ApiQuery({ name: 'severity', required: false, enum: ClaimSeverity })
  @ApiQuery({ name: 'channel', required: false, enum: IntakeChannel })
  @ApiQuery({ name: 'assignee_id', required: false, type: String })
  @ApiQuery({ name: 'skip', required: false, type: Number })
  @ApiQuery({ name: 'take', required: false, type: Number })
  @ApiResponse({ status: 200, description: 'List of role-masked claims.' })
  async findAll(
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
    @Query('status') status?: ClaimStatus,
    @Query('severity') severity?: ClaimSeverity,
    @Query('channel') channel?: IntakeChannel,
    @Query('assignee_id') assignee_id?: string,
    @Query('skip') skip?: string,
    @Query('take') take?: string,
  ) {
    const caller = buildCallerContext(user, req);
    return this.claimsService.findAll(caller, {
      status,
      severity,
      channel,
      assignee_id,
      skip: skip !== undefined ? parseInt(skip, 10) : undefined,
      take: take !== undefined ? parseInt(take, 10) : undefined,
    });
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GET /claims/:id — role-masked detail
  // ─────────────────────────────────────────────────────────────────────────

  @Get(':id')
  @Roles(
    UserRole.agent,
    UserRole.adjuster,
    UserRole.manager,
    UserRole.auditor,
    UserRole.siu_referrer,
  )
  @ApiOperation({
    summary: 'Get claim detail (role-masked)',
    description:
      'Returns the full detail of a claim, with PII masked per the caller role. ' +
      'Adjusters see cleartext PII only for assigned claims.',
  })
  @ApiResponse({ status: 200, description: 'Role-masked claim detail.' })
  @ApiResponse({ status: 403, description: 'Caller does not have access to this claim.' })
  @ApiResponse({ status: 404, description: 'Claim not found.' })
  async findOne(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const caller = buildCallerContext(user, req);
    return this.claimsService.findOne(id, caller);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // POST /claims/:id/assign — assign / re-assign adjuster (manager only)
  // ─────────────────────────────────────────────────────────────────────────

  @Post(':id/assign')
  @Roles(UserRole.manager)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Assign or re-assign adjuster to claim (manager only)',
    description:
      'Assigns the specified adjuster to the claim. ' +
      'If the claim already has an assigned adjuster, this is a reassignment. ' +
      'reason_for_reassignment is recommended on reassignment.',
  })
  @ApiResponse({ status: 200, description: 'Adjuster assigned.' })
  @ApiResponse({ status: 400, description: 'Invalid adjuster_id or target user is not an adjuster.' })
  @ApiResponse({ status: 403, description: 'Caller is not a manager.' })
  @ApiResponse({ status: 404, description: 'Claim not found.' })
  async assignAdjuster(
    @Param('id') id: string,
    @Body() dto: AssignClaimDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const caller = buildCallerContext(user, req);
    return this.claimsService.assignAdjuster(id, dto, caller);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // POST /claims/:id/notes — append-only note
  // ─────────────────────────────────────────────────────────────────────────

  @Post(':id/notes')
  @Roles(UserRole.adjuster, UserRole.manager)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Append an immutable note to a claim',
    description:
      'Appends a timestamped, immutable note to the claim. ' +
      'Notes are never edited — corrections require a new note. ' +
      'Adjusters may only note their assigned claims.',
  })
  @ApiResponse({ status: 201, description: 'Note appended.' })
  @ApiResponse({ status: 403, description: 'Insufficient permissions.' })
  @ApiResponse({ status: 404, description: 'Claim not found.' })
  async addNote(
    @Param('id') id: string,
    @Body() dto: AddNoteDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const caller = buildCallerContext(user, req);
    return this.claimsService.addNote(id, dto, caller);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // POST /claims/:id/evidence — attach evidence
  // ─────────────────────────────────────────────────────────────────────────

  @Post(':id/evidence')
  @Roles(UserRole.adjuster)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Attach evidence to a claim (adjuster only)',
    description:
      'Attaches an evidence record (photo, document, audio, video, or witness statement attachment) ' +
      'to the claim. Blob storage is stubbed — only the content_hash and blob_ref are persisted.',
  })
  @ApiResponse({ status: 201, description: 'Evidence attached.' })
  @ApiResponse({ status: 403, description: 'Caller is not the assigned adjuster.' })
  @ApiResponse({ status: 404, description: 'Claim not found.' })
  async addEvidence(
    @Param('id') id: string,
    @Body() dto: AddEvidenceDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const caller = buildCallerContext(user, req);
    return this.claimsService.addEvidence(id, dto, caller);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // POST /claims/:id/witness-statement — structured witness intake
  // ─────────────────────────────────────────────────────────────────────────

  @Post(':id/witness-statement')
  @Roles(UserRole.adjuster)
  @HttpCode(HttpStatus.CREATED)
  @ApiOperation({
    summary: 'Record a structured witness statement (adjuster only)',
    description:
      'Records a structured witness statement for the claim. ' +
      'The inkan_seal_hash field captures the digital equivalent of a Japanese hanko seal, ' +
      'binding the witness acknowledgement to the statement content and timestamp.',
  })
  @ApiResponse({ status: 201, description: 'Witness statement recorded.' })
  @ApiResponse({ status: 403, description: 'Caller is not the assigned adjuster.' })
  @ApiResponse({ status: 404, description: 'Claim not found.' })
  async addWitnessStatement(
    @Param('id') id: string,
    @Body() dto: AddWitnessStatementDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const caller = buildCallerContext(user, req);
    return this.claimsService.addWitnessStatement(id, dto, caller);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // PATCH /claims/:id/status — FSM-guarded status transition
  // ─────────────────────────────────────────────────────────────────────────

  @Patch(':id/status')
  @Roles(UserRole.adjuster, UserRole.manager)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Transition claim status (FSM-guarded)',
    description:
      'Transitions the claim to the requested status. ' +
      'Illegal transitions return 422 with the FSM refusal reason. ' +
      'Adjusters may only transition their assigned claims. ' +
      'Certain transitions are manager-only (see ADR-004).',
  })
  @ApiResponse({ status: 200, description: 'Status transitioned.' })
  @ApiResponse({
    status: 422,
    description: 'Illegal transition — FSM refusal with reason and code.',
  })
  @ApiResponse({ status: 403, description: 'Insufficient permissions.' })
  @ApiResponse({ status: 404, description: 'Claim not found.' })
  async updateStatus(
    @Param('id') id: string,
    @Body() dto: UpdateStatusDto,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const caller = buildCallerContext(user, req);
    return this.claimsService.updateStatus(id, dto, caller);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // GET /claims/:id/data-subject-export — APPI Article 28 disclosure
  // ─────────────────────────────────────────────────────────────────────────

  @Get(':id/data-subject-export')
  @Roles(UserRole.auditor, UserRole.manager)
  @ApiOperation({
    summary: 'APPI Article 28 data-subject export (auditor/manager only)',
    description:
      'Returns all personal data held by the system about the individual ' +
      'associated with the claim. Encrypted special-care PII fields are returned ' +
      'as base64-encoded ciphertext blobs for downstream authorised decryption. ' +
      'Every invocation emits an AuditEvent.',
  })
  @ApiResponse({ status: 200, description: 'Data-subject disclosure document.' })
  @ApiResponse({ status: 403, description: 'Caller is not auditor or manager.' })
  @ApiResponse({ status: 404, description: 'Claim not found.' })
  async dataSubjectExport(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const caller = buildCallerContext(user, req);
    return this.claimsService.dataSubjectExport(id, caller);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // DELETE /claims/:id/personal-data-anonymise — APPI PII redaction
  // ─────────────────────────────────────────────────────────────────────────

  @Delete(':id/personal-data-anonymise')
  @Roles(UserRole.manager, UserRole.auditor)
  @HttpCode(HttpStatus.OK)
  @ApiOperation({
    summary: 'Anonymise personal data for a claim (manager only)',
    description:
      'Redacts PII fields from the claim record while preserving the immutable audit trail. ' +
      'This is the APPI erasure/anonymisation pathway. ' +
      'The audit trail is never touched — only claim PII fields are redacted.',
  })
  @ApiResponse({ status: 200, description: 'PII anonymised successfully.' })
  @ApiResponse({ status: 403, description: 'Caller is not a manager.' })
  @ApiResponse({ status: 404, description: 'Claim not found.' })
  async anonymisePersonalData(
    @Param('id') id: string,
    @CurrentUser() user: AuthenticatedUser,
    @Req() req: Request,
  ) {
    const caller = buildCallerContext(user, req);
    return this.claimsService.anonymisePersonalData(id, caller);
  }
}