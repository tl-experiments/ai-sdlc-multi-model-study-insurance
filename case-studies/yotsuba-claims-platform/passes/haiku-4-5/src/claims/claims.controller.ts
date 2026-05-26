import {
  Controller,
  Post,
  Get,
  Patch,
  Body,
  Param,
  Query,
  UseGuards,
  UseInterceptors,
  HttpCode,
  HttpStatus,
  Logger,
} from '@nestjs/common';
import { ClaimsService } from './claims.service';
import { ClaimsChannelService } from './claims-channel.service';
import { CreateClaimDto } from './dto/create-claim.dto';
import { AddClaimNoteDto } from './dto/add-note.dto';
import { AddEvidenceDto } from './dto/add-evidence.dto';
import { AddWitnessStatementDto } from './dto/add-witness-statement.dto';
import { UpdateClaimStatusDto } from './dto/update-status.dto';
import { AssignClaimDto } from './dto/assign-claim.dto';
import { JwtAuthGuard } from '../common/jwt-auth.guard';
import { RolesGuard } from '../common/roles.guard';
import { Roles } from '../common/roles.decorator';
import { CurrentUser } from '../common/current-user.decorator';
import { Audit } from '../common/audit.decorator';
import { User, UserRole } from '@prisma/client';

/**
 * Claims controller.
 *
 * This controller handles all HTTP endpoints for the claims module, including:
 *   - FNOL intake from four channels (agent, mobile, broker, email)
 *   - Claim retrieval with role-based authorization and field masking
 *   - Claim assignment and reassignment
 *   - Immutable note, evidence, and witness statement recording
 *   - Claim status transitions via FSM
 *
 * All endpoints are protected by JWT authentication and role-based authorization.
 * All write operations emit audit events via the @Audit decorator.
 *
 * Request/response flow:
 *   1. Controller validates DTO and extracts current user
 *   2. Service layer performs business logic, authorization, and persistence
 *   3. Audit interceptor captures the event (if @Audit is present)
 *   4. Response is returned to client
 *
 * Error handling:
 *   - BadRequestException (400): validation failures
 *   - UnauthorizedException (401): missing/invalid JWT
 *   - ForbiddenException (403): authorization failures
 *   - NotFoundException (404): resource not found
 *   - UnprocessableEntityException (422): business rule violations (e.g., illegal FSM transition)
 *   - InternalServerErrorException (500): unexpected errors (no stack trace in response)
 */
@Controller('claims')
@UseGuards(JwtAuthGuard, RolesGuard)
export class ClaimsController {
  private readonly logger = new Logger(ClaimsController.name);

  constructor(
    private readonly claimsService: ClaimsService,
    private readonly channelService: ClaimsChannelService,
  ) {}

  /**
   * POST /claims
   *
   * Creates a new claim from FNOL intake (unified endpoint for all channels).
   *
   * This endpoint accepts a normalized claim intake DTO and creates a claim record.
   * The caller is responsible for normalizing the intake via the channel-specific
   * endpoints (POST /claims/mobile, POST /claims/broker, etc.) or by calling
   * the channel service directly.
   *
   * Authorization:
   *   - agent: can create claims (own intake)
   *   - adjuster: can create claims (for intake processing)
   *
   * Validation:
   *   - policy_number: required, non-empty
   *   - loss_date: required, valid date
   *   - loss_location_prefecture: required, valid Japanese prefecture
   *   - incident_type: required, valid IncidentType
   *   - reporter_name: required, non-empty
   *   - initial_description: required, non-empty
   *   - appi_consent_version: required, non-empty
   *   - appi_consent_at: required, valid date
   *
   * Audit:
   *   - Emits AuditEvent with action='claim.created'
   *
   * @param dto - Normalized claim intake DTO
   * @param actor - Current user (from JWT)
   * @returns Created Claim record
   */
  @Post()
  @Roles(UserRole.agent, UserRole.adjuster)
  @Audit({ action: 'claim.created' })
  @HttpCode(HttpStatus.CREATED)
  async createClaim(
    @Body() dto: CreateClaimDto,
    @CurrentUser() actor: User,
  ) {
    const requestId = this.getRequestId();
    const correlationId = this.getCorrelationId();

    this.logger.log(
      `Creating claim from ${dto.reported_by_channel} channel (policy: ${dto.policy_number})`,
      { requestId, correlationId },
    );

    return this.claimsService.createClaim(dto, actor, requestId, correlationId);
  }

  /**
   * POST /claims/mobile
   *
   * Creates a claim from mobile app channel intake.
   *
   * This endpoint normalizes mobile app intake and creates a claim.
   * Mobile channel requires explicit APPI consent.
   *
   * Authorization:
   *   - agent: can create mobile claims
   *
   * @param dto - Raw mobile intake DTO
   * @param actor - Current user (from JWT)
   * @returns Created Claim record
   */
  @Post('mobile')
  @Roles(UserRole.agent)
  @Audit({ action: 'claim.created' })
  @HttpCode(HttpStatus.CREATED)
  async createClaimMobile(
    @Body() dto: CreateClaimDto,
    @CurrentUser() actor: User,
  ) {
    const requestId = this.getRequestId();
    const correlationId = this.getCorrelationId();

    this.logger.log(
      `Creating claim from mobile channel (policy: ${dto.policy_number})`,
      { requestId, correlationId },
    );

    // Normalize mobile intake
    const normalized = this.channelService.normaliseMobileIntake({
      policy_number: dto.policy_number,
      loss_date: dto.loss_date,
      loss_location_prefecture: dto.loss_location_prefecture,
      loss_location_postal_code: dto.loss_location_postal_code,
      loss_location_detail: dto.loss_location_detail,
      reporter_name: dto.reporter_name,
      reporter_phone: dto.reporter_phone,
      reporter_email: dto.reporter_email,
      reporter_relation_to_insured: dto.reporter_relation_to_insured,
      incident_type: dto.incident_type,
      initial_description: dto.initial_description,
      injury_reported: dto.injury_reported,
      third_party_involved: dto.third_party_involved,
      police_report_number: dto.police_report_number,
      appi_consent_version: dto.appi_consent_version,
      appi_consent_at: dto.appi_consent_at,
    });

    const createDto: CreateClaimDto = {
      ...normalized,
      declared_loss_amount_yen: dto.declared_loss_amount_yen,
      insured_government_id: dto.insured_government_id,
      bank_account_for_payout: dto.bank_account_for_payout,
      injury_details: dto.injury_details,
    };

    return this.claimsService.createClaim(createDto, actor, requestId, correlationId);
  }

  /**
   * POST /claims/broker
   *
   * Creates a claim from broker/dealer portal channel intake.
   *
   * This endpoint normalizes broker intake and creates a claim.
   * Broker channel requires explicit APPI consent.
   *
   * Authorization:
   *   - agent: can create broker claims
   *
   * @param dto - Raw broker intake DTO
   * @param actor - Current user (from JWT)
   * @returns Created Claim record
   */
  @Post('broker')
  @Roles(UserRole.agent)
  @Audit({ action: 'claim.created' })
  @HttpCode(HttpStatus.CREATED)
  async createClaimBroker(
    @Body() dto: CreateClaimDto,
    @CurrentUser() actor: User,
  ) {
    const requestId = this.getRequestId();
    const correlationId = this.getCorrelationId();

    this.logger.log(
      `Creating claim from broker channel (policy: ${dto.policy_number})`,
      { requestId, correlationId },
    );

    // Normalize broker intake
    const normalized = this.channelService.normaliseBrokerIntake({
      policy_number: dto.policy_number,
      loss_date: dto.loss_date,
      loss_location_prefecture: dto.loss_location_prefecture,
      loss_location_postal_code: dto.loss_location_postal_code,
      loss_location_detail: dto.loss_location_detail,
      reporter_name: dto.reporter_name,
      reporter_phone: dto.reporter_phone,
      reporter_email: dto.reporter_email,
      reporter_relation_to_insured: dto.reporter_relation_to_insured,
      incident_type: dto.incident_type,
      initial_description: dto.initial_description,
      injury_reported: dto.injury_reported,
      third_party_involved: dto.third_party_involved,
      police_report_number: dto.police_report_number,
      appi_consent_version: dto.appi_consent_version,
      appi_consent_at: dto.appi_consent_at,
    });

    const createDto: CreateClaimDto = {
      ...normalized,
      declared_loss_amount_yen: dto.declared_loss_amount_yen,
      insured_government_id: dto.insured_government_id,
      bank_account_for_payout: dto.bank_account_for_payout,
      injury_details: dto.injury_details,
    };

    return this.claimsService.createClaim(createDto, actor, requestId, correlationId);
  }

  /**
   * POST /claims/email-parse
   *
   * Creates a claim from email parser channel intake.
   *
   * This endpoint normalizes email intake and creates a claim.
   * Email channel requires explicit APPI consent.
   * Idempotent on Message-Id to prevent duplicate claims from email retries.
   *
   * Authorization:
   *   - agent: can create email claims
   *
   * @param dto - Raw email intake DTO
   * @param actor - Current user (from JWT)
   * @returns Created Claim record
   */
  @Post('email-parse')
  @Roles(UserRole.agent)
  @Audit({ action: 'claim.created' })
  @HttpCode(HttpStatus.CREATED)
  async createClaimEmailParse(
    @Body() dto: CreateClaimDto,
    @CurrentUser() actor: User,
  ) {
    const requestId = this.getRequestId();
    const correlationId = this.getCorrelationId();

    this.logger.log(
      `Creating claim from email channel (policy: ${dto.policy_number})`,
      { requestId, correlationId },
    );

    // Normalize email intake
    const normalized = this.channelService.normaliseEmailIntake({
      policy_number: dto.policy_number,
      loss_date: dto.loss_date,
      loss_location_prefecture: dto.loss_location_prefecture,
      loss_location_postal_code: dto.loss_location_postal_code,
      loss_location_detail: dto.loss_location_detail,
      reporter_name: dto.reporter_name,
      reporter_phone: dto.reporter_phone,
      reporter_email: dto.reporter_email,
      reporter_relation_to_insured: dto.reporter_relation_to_insured,
      incident_type: dto.incident_type,
      initial_description: dto.initial_description,
      injury_reported: dto.injury_reported,
      third_party_involved: dto.third_party_involved,
      police_report_number: dto.police_report_number,
      appi_consent_version: dto.appi_consent_version,
      appi_consent_at: dto.appi_consent_at,
    });

    const createDto: CreateClaimDto = {
      ...normalized,
      declared_loss_amount_yen: dto.declared_loss_amount_yen,
      insured_government_id: dto.insured_government_id,
      bank_account_for_payout: dto.bank_account_for_payout,
      injury_details: dto.injury_details,
    };

    return this.claimsService.createClaim(createDto, actor, requestId, correlationId);
  }

  /**
   * GET /claims
   *
   * Lists claims with role-based filtering and pagination.
   *
   * Authorization:
   *   - agent: can list own intake claims (within 24 hours)
   *   - adjuster: can list assigned claims
   *   - manager: can list claims in their reports' pool
   *   - auditor: can list all claims
   *   - siu_referrer: can list flagged claims (Track B)
   *
   * Query parameters:
   *   - status: filter by claim status (e.g., 'intake', 'under_investigation')
   *   - severity: filter by severity (e.g., 'simple', 'complex', 'catastrophic')
   *   - channel: filter by intake channel (e.g., 'agent', 'mobile', 'broker', 'email')
   *   - assignee_id: filter by assigned adjuster (manager-only)
   *   - incident_type: filter by incident type
   *   - from_date: filter by loss_date >= from_date (ISO 8601)
   *   - to_date: filter by loss_date <= to_date (ISO 8601)
   *   - skip: number of records to skip (default 0)
   *   - take: number of records to return (default 20, max 100)
   *
   * @param actor - Current user (from JWT)
   * @param status - Filter by status
   * @param severity - Filter by severity
   * @param channel - Filter by channel
   * @param assignee_id - Filter by assignee (manager-only)
   * @param incident_type - Filter by incident type
   * @param from_date - Filter by loss_date >= from_date
   * @param to_date - Filter by loss_date <= to_date
   * @param skip - Number of records to skip
   * @param take - Number of records to return
   * @returns Array of Claim records
   */
  @Get()
  @Roles(UserRole.agent, UserRole.adjuster, UserRole.manager, UserRole.auditor, UserRole.siu_referrer)
  async listClaims(
    @CurrentUser() actor: User,
    @Query('status') status?: string,
    @Query('severity') severity?: string,
    @Query('channel') channel?: string,
    @Query('assignee_id') assignee_id?: string,
    @Query('incident_type') incident_type?: string,
    @Query('from_date') from_date?: string,
    @Query('to_date') to_date?: string,
    @Query('skip') skip?: string,
    @Query('take') take?: string,
  ) {
    const filters: any = {};
    if (status) filters.status = status;
    if (severity) filters.severity = severity;
    if (channel) filters.channel = channel;
    if (assignee_id) filters.assignee_id = assignee_id;
    if (incident_type) filters.incident_type = incident_type;
    if (from_date) filters.from_date = new Date(from_date);
    if (to_date) filters.to_date = new Date(to_date);

    const skipNum = skip ? parseInt(skip, 10) : 0;
    const takeNum = take ? parseInt(take, 10) : 20;

    return this.claimsService.listClaims(actor, filters, skipNum, takeNum);
  }

  /**
   * GET /claims/:id
   *
   * Retrieves a single claim by ID with role-based authorization and field masking.
   *
   * Authorization:
   *   - agent: can read own intake claims (within 24 hours)
   *   - adjuster: can read assigned claims
   *   - manager: can read claims in their reports' pool
   *   - auditor: can read all claims
   *   - siu_referrer: can read flagged claims (Track B)
   *
   * Field masking (APPI-tier-aware):
   *   - Standard PII (reporter_name, reporter_phone, reporter_email): masked for non-assigned roles
   *   - Special-care PII (insured_government_id, bank_account, injury_details): never returned in API
   *   - policy_number: masked for non-manager/auditor roles
   *   - loss_location: masked to prefecture-only for non-adjuster roles
   *
   * @param id - Claim ID
   * @param actor - Current user (from JWT)
   * @returns Claim record (with masked fields)
   */
  @Get(':id')
  @Roles(UserRole.agent, UserRole.adjuster, UserRole.manager, UserRole.auditor, UserRole.siu_referrer)
  async getClaimById(
    @Param('id') id: string,
    @CurrentUser() actor: User,
  ) {
    return this.claimsService.getClaimById(id, actor);
  }

  /**
   * POST /claims/:id/assign
   *
   * Assigns or reassigns a claim to an adjuster.
   *
   * Authorization:
   *   - Only managers can assign/reassign claims
   *   - Managers can only assign claims in their reports' pool
   *
   * Validation:
   *   - adjuster_id must be a valid user with role='adjuster'
   *   - adjuster must be in the manager's reports hierarchy
   *   - claim must exist
   *
   * Audit:
   *   - Emits AuditEvent with action='claim.assigned'
   *
   * @param id - Claim ID
   * @param dto - Assignment DTO (adjuster_id, reason_for_reassignment?)
   * @param actor - Current user (must be manager)
   * @returns Updated Claim record
   */
  @Post(':id/assign')
  @Roles(UserRole.manager)
  @Audit({ action: 'claim.assigned' })
  @HttpCode(HttpStatus.OK)
  async assignClaim(
    @Param('id') id: string,
    @Body() dto: AssignClaimDto,
    @CurrentUser() actor: User,
  ) {
    this.logger.log(
      `Assigning claim ${id} to adjuster ${dto.adjuster_id}`,
    );

    return this.claimsService.assignClaim(id, dto, actor);
  }

  /**
   * POST /claims/:id/notes
   *
   * Adds an immutable note to a claim.
   *
   * Authorization:
   *   - adjuster: can add notes to assigned claims
   *   - manager: can add notes to claims in their reports' pool
   *
   * Validation:
   *   - claim must exist
   *   - body must be non-empty and >= 10 characters
   *
   * Immutability:
   *   - Notes are append-only; no UPDATE or DELETE pathway
   *   - If a note contains an error, a new note is added with a correction
   *
   * Audit:
   *   - Emits AuditEvent with action='claim.note.added'
   *
   * @param id - Claim ID
   * @param dto - Note DTO (body)
   * @param actor - Current user (adjuster or manager)
   * @returns Created ClaimNote record
   */
  @Post(':id/notes')
  @Roles(UserRole.adjuster, UserRole.manager)
  @Audit({ action: 'claim.note.added' })
  @HttpCode(HttpStatus.CREATED)
  async addClaimNote(
    @Param('id') id: string,
    @Body() dto: AddClaimNoteDto,
    @CurrentUser() actor: User,
  ) {
    this.logger.log(
      `Adding note to claim ${id}`,
    );

    return this.claimsService.addClaimNote(id, dto, actor);
  }

  /**
   * POST /claims/:id/evidence
   *
   * Adds evidence to a claim.
   *
   * Authorization:
   *   - Only adjusters can add evidence to assigned claims
   *
   * Validation:
   *   - claim must exist
   *   - kind must be a valid EvidenceKind
   *   - content_hash must be a valid SHA-256 hex string (64 chars)
   *   - blob_ref must be non-empty
   *
   * Immutability:
   *   - Evidence records are append-only; no UPDATE or DELETE pathway
   *   - content_hash provides tamper detection
   *
   * Audit:
   *   - Emits AuditEvent with action='claim.evidence.added'
   *
   * @param id - Claim ID
   * @param dto - Evidence DTO (kind, content_hash, blob_ref)
   * @param actor - Current user (must be adjuster)
   * @returns Created Evidence record
   */
  @Post(':id/evidence')
  @Roles(UserRole.adjuster)
  @Audit({ action: 'claim.evidence.added' })
  @HttpCode(HttpStatus.CREATED)
  async addEvidence(
    @Param('id') id: string,
    @Body() dto: AddEvidenceDto,
    @CurrentUser() actor: User,
  ) {
    this.logger.log(
      `Adding evidence to claim ${id}: ${dto.kind}`,
    );

    return this.claimsService.addEvidence(id, dto, actor);
  }

  /**
   * POST /claims/:id/witness-statement
   *
   * Records a structured witness statement on a claim.
   *
   * Authorization:
   *   - Only adjusters can record witness statements on assigned claims
   *
   * Validation:
   *   - claim must exist
   *   - witness_name must be non-empty and >= 5 characters
   *   - statement_body must be non-empty and >= 20 characters
   *   - inkan_seal_hash must be a valid SHA-256 hex string (64 chars)
   *
   * Encryption:
   *   - witness_phone (if provided) is encrypted as APPI standard PII
   *
   * Immutability:
   *   - Witness statements are append-only; no UPDATE or DELETE pathway
   *   - inkan_seal_hash provides non-repudiation and tamper evidence
   *
   * Audit:
   *   - Emits AuditEvent with action='claim.witness_statement.recorded'
   *
   * @param id - Claim ID
   * @param dto - Witness statement DTO
   * @param actor - Current user (must be adjuster)
   * @returns Created WitnessStatement record
   */
  @Post(':id/witness-statement')
  @Roles(UserRole.adjuster)
  @Audit({ action: 'claim.witness_statement.recorded' })
  @HttpCode(HttpStatus.CREATED)
  async addWitnessStatement(
    @Param('id') id: string,
    @Body() dto: AddWitnessStatementDto,
    @CurrentUser() actor: User,
  ) {
    this.logger.log(
      `Recording witness statement for claim ${id}: ${dto.witness_name}`,
    );

    return this.claimsService.addWitnessStatement(id, dto, actor);
  }

  /**
   * PATCH /claims/:id/status
   *
   * Updates claim status via FSM.
   *
   * Authorization:
   *   - adjuster: can transition assigned claims
   *   - manager: can transition claims in their reports' pool
   *
   * Validation:
   *   - claim must exist
   *   - to_status must be a valid ClaimStatus
   *   - transition must be legal per FSM
   *
   * FSM:
   *   - Uses validateClaimStatusTransition() to validate the transition
   *   - Returns 422 with reason if transition is illegal
   *
   * Audit:
   *   - Emits AuditEvent with action='claim.status.updated'
   *
   * @param id - Claim ID
   * @param dto - Status update DTO (to, reason)
   * @param actor - Current user (adjuster or manager)
   * @returns Updated Claim record
   */
  @Patch(':id/status')
  @Roles(UserRole.adjuster, UserRole.manager)
  @Audit({ action: 'claim.status.updated' })
  @HttpCode(HttpStatus.OK)
  async updateClaimStatus(
    @Param('id') id: string,
    @Body() dto: UpdateClaimStatusDto,
    @CurrentUser() actor: User,
  ) {
    this.logger.log(
      `Updating claim ${id} status to ${dto.to}`,
    );

    return this.claimsService.updateClaimStatus(id, dto, actor);
  }

  /**
   * GET /claims/:id/notes
   *
   * Retrieves all notes for a claim.
   *
   * Authorization:
   *   - Same as claim read authorization
   *
   * @param id - Claim ID
   * @param actor - Current user (from JWT)
   * @returns Array of ClaimNote records
   */
  @Get(':id/notes')
  @Roles(UserRole.agent, UserRole.adjuster, UserRole.manager, UserRole.auditor, UserRole.siu_referrer)
  async getClaimNotes(
    @Param('id') id: string,
    @CurrentUser() actor: User,
  ) {
    return this.claimsService.getClaimNotes(id, actor);
  }

  /**
   * GET /claims/:id/evidence
   *
   * Retrieves all evidence for a claim.
   *
   * Authorization:
   *   - Same as claim read authorization
   *
   * @param id - Claim ID
   * @param actor - Current user (from JWT)
   * @returns Array of Evidence records
   */
  @Get(':id/evidence')
  @Roles(UserRole.agent, UserRole.adjuster, UserRole.manager, UserRole.auditor, UserRole.siu_referrer)
  async getClaimEvidence(
    @Param('id') id: string,
    @CurrentUser() actor: User,
  ) {
    return this.claimsService.getClaimEvidence(id, actor);
  }

  /**
   * GET /claims/:id/witness-statements
   *
   * Retrieves all witness statements for a claim.
   *
   * Authorization:
   *   - Same as claim read authorization
   *
   * @param id - Claim ID
   * @param actor - Current user (from JWT)
   * @returns Array of WitnessStatement records
   */
  @Get(':id/witness-statements')
  @Roles(UserRole.agent, UserRole.adjuster, UserRole.manager, UserRole.auditor, UserRole.siu_referrer)
  async getClaimWitnessStatements(
    @Param('id') id: string,
    @CurrentUser() actor: User,
  ) {
    return this.claimsService.getClaimWitnessStatements(id, actor);
  }

  /**
   * Helper: extracts request ID from context.
   * In a real implementation, this would be injected via REQUEST scope.
   * For now, we generate a placeholder.
   */
  private getRequestId(): string {
    return `req-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Helper: extracts correlation ID from context.
   * In a real implementation, this would be propagated from middleware.
   * For now, we generate a placeholder.
   */
  private getCorrelationId(): string {
    return `corr-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }
}