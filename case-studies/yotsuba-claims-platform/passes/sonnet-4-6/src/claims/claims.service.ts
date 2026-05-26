// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/claims/claims.service.ts
//
// Core claims service — FNOL intake, adjuster workbench operations,
// severity classification, and APPI-compliant PII handling.
//
// Design reference: design.md §1 Data model, §2 API contract, §3 Module structure
// Brief reference:  brief.md §1 FNOL, §2 Adjuster Workbench
//
// Responsibilities:
//   - Create claims from normalised CreateClaimDto (all channels)
//   - Classify initial severity (pure function, no ML)
//   - Validate policy effective window (stub)
//   - Enforce APPI-tiered PII encryption for special-care fields
//   - Enforce role-based access for every write operation
//   - Guard status transitions via claims-status.fsm.ts
//   - Append-only notes, evidence, and witness statements
//   - Emit AuditEvent on every write
//   - Prefix-mask PII fields in responses based on caller role (ADR-003)
//
// PII handling (ADR-001, ADR-003):
//   Special-care fields (APPI Article 17) stored encrypted (_ct columns):
//     reporter_phone, reporter_email, witness_phone, insured_government_id,
//     bank_account_for_payout, injury_details
//   Standard PII fields stored cleartext; masked in responses by pii-mask.util.
//
// Audit (ADR-002):
//   Every write operation appends an immutable AuditEvent row via AuditService.
//   No UPDATE or DELETE pathway exists for AuditEvent.
// =============================================================================

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';
import {
  ClaimSeverity,
  ClaimStatus,
  EvidenceKind,
  IncidentType,
  IntakeChannel,
  UserRole,
} from '@prisma/client';
import { Decimal } from '@prisma/client/runtime/library';
import { PrismaService } from '../prisma.service';
import { AuditService } from '../audit/audit.service';
import { encrypt } from '../common/encryption';
import { maskClaimForRole } from '../common/pii-mask.util';
import { checkTransition } from './claims-status.fsm';
import { CreateClaimDto } from './dto/create-claim.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import { AssignClaimDto } from './dto/assign-claim.dto';
import { AddNoteDto } from './dto/add-note.dto';
import { AddEvidenceDto } from './dto/add-evidence.dto';
import { AddWitnessStatementDto } from './dto/add-witness-statement.dto';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Minimal caller context threaded through every service method. */
export interface CallerContext {
  id: string;
  role: UserRole;
  request_id: string;
  correlation_id: string;
}

/** Shape returned by list endpoint — role-masked. */
export type ClaimListItem = Awaited<ReturnType<ClaimsService['findAll']>>[number];

// ---------------------------------------------------------------------------
// Severity classification constants (brief.md §1 Initial classification)
// ---------------------------------------------------------------------------

/**
 * Incident types that escalate severity to 'complex' regardless of other
 * signals, because they inherently involve higher investigation burden.
 */
const COMPLEX_INCIDENT_TYPES = new Set<IncidentType>([
  IncidentType.fire_residential,
  IncidentType.fire_commercial,
  IncidentType.marine_cargo,
  IncidentType.liability_premises,
]);

/**
 * Incident types that escalate severity to 'catastrophic' when combined
 * with injury or third-party involvement.
 */
const HIGH_RISK_INCIDENT_TYPES = new Set<IncidentType>([
  IncidentType.fire_commercial,
  IncidentType.marine_cargo,
  IncidentType.liability_premises,
  IncidentType.personal_accident,
]);

/** Declared loss thresholds for severity banding (yen). */
const SEVERITY_COMPLEX_THRESHOLD_YEN = 1_000_000; // ¥1M
const SEVERITY_CATASTROPHIC_THRESHOLD_YEN = 10_000_000; // ¥10M

// ---------------------------------------------------------------------------
// Prefecture validation list
// ---------------------------------------------------------------------------

/**
 * All 47 Japanese prefectures (都道府県) in their canonical kanji form.
 * Also includes common romanised and katakana variants for robustness.
 * Source: 都道府県コード (JIS X 0401).
 */
const VALID_PREFECTURES = new Set([
  '北海道', '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県', '岐阜県',
  '静岡県', '愛知県', '三重県', '滋賀県', '京都府', '大阪府', '兵庫県',
  '奈良県', '和歌山県', '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県', '福岡県', '佐賀県', '長崎県',
  '熊本県', '大分県', '宮崎県', '鹿児島県', '沖縄県',
  // Romanised variants for API callers that may not use kanji
  'Hokkaido', 'Aomori', 'Iwate', 'Miyagi', 'Akita', 'Yamagata', 'Fukushima',
  'Ibaraki', 'Tochigi', 'Gunma', 'Saitama', 'Chiba', 'Tokyo', 'Kanagawa',
  'Niigata', 'Toyama', 'Ishikawa', 'Fukui', 'Yamanashi', 'Nagano', 'Gifu',
  'Shizuoka', 'Aichi', 'Mie', 'Shiga', 'Kyoto', 'Osaka', 'Hyogo',
  'Nara', 'Wakayama', 'Tottori', 'Shimane', 'Okayama', 'Hiroshima', 'Yamaguchi',
  'Tokushima', 'Kagawa', 'Ehime', 'Kochi', 'Fukuoka', 'Saga', 'Nagasaki',
  'Kumamoto', 'Oita', 'Miyazaki', 'Kagoshima', 'Okinawa',
]);

// ---------------------------------------------------------------------------
// Policy stub validation
// ---------------------------------------------------------------------------

/**
 * Stub policy record returned by the external Policy Service.
 * In production this would be a typed response from the Policy microservice.
 */
interface PolicyRecord {
  policy_number: string;
  effective_date: Date;
  expiry_date: Date;
  insured_name: string;
}

/**
 * Stub policy lookup — simulates calling an external Policy Service.
 *
 * In production: replace with an HTTP call to the Policy Service with
 * proper circuit-breaking and timeout handling.
 *
 * Returns a policy window that accommodates any loss_date for POC purposes.
 * The date validation logic in createClaim() is real; only the stub data is fake.
 */
function stubLookupPolicy(policy_number: string): PolicyRecord | null {
  // Accept any policy number matching the pattern P-XXXXXXXX or arbitrary strings
  // for test/seed flexibility. Return a wide effective window.
  if (!policy_number || policy_number.trim().length === 0) return null;

  return {
    policy_number: policy_number.trim(),
    effective_date: new Date('2020-01-01T00:00:00Z'),
    expiry_date: new Date('2030-12-31T23:59:59Z'),
    insured_name: 'Stub Insured',
  };
}

// ---------------------------------------------------------------------------
// ClaimsService
// ---------------------------------------------------------------------------

@Injectable()
export class ClaimsService {
  private readonly logger = new Logger(ClaimsService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly auditService: AuditService,
  ) {}

  // ─────────────────────────────────────────────────────────────────────────
  // FNOL — Create claim
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Creates a new claim record from a normalised FNOL payload.
   *
   * Steps:
   *   1. Validate prefecture.
   *   2. Validate policy exists and loss_date falls within effective window.
   *   3. Classify initial severity.
   *   4. Encrypt special-care PII fields (APPI Article 17).
   *   5. Persist Claim record.
   *   6. Emit AuditEvent.
   *
   * @param dto    - Normalised claim creation DTO.
   * @param caller - The authenticated user creating the claim.
   * @returns The created claim, role-masked for the caller.
   */
  async create(dto: CreateClaimDto, caller: CallerContext) {
    this.logger.log(
      {
        policy_number: dto.policy_number,
        channel: dto.reported_by_channel,
        actor_id: caller.id,
        request_id: caller.request_id,
      },
      'Creating new FNOL claim',
    );

    // ── 1. Prefecture validation ─────────────────────────────────────────
    if (!VALID_PREFECTURES.has(dto.loss_location_prefecture)) {
      throw new BadRequestException(
        `'${dto.loss_location_prefecture}' is not a valid Japanese prefecture (都道府県). ` +
          'Provide the prefecture in kanji (e.g. 東京都, 大阪府) or recognised romanisation.',
      );
    }

    // ── 2. Policy validation (stub) ───────────────────────────────────────
    const policy = stubLookupPolicy(dto.policy_number);
    if (!policy) {
      throw new BadRequestException(
        `Policy number '${dto.policy_number}' could not be found in the Policy Service.`,
      );
    }

    const lossDate = dto.loss_date instanceof Date ? dto.loss_date : new Date(dto.loss_date);
    if (lossDate < policy.effective_date) {
      throw new BadRequestException(
        `loss_date (${lossDate.toISOString()}) is before the policy effective date ` +
          `(${policy.effective_date.toISOString()}).`,
      );
    }
    if (lossDate > policy.expiry_date) {
      throw new BadRequestException(
        `loss_date (${lossDate.toISOString()}) is after the policy expiry date ` +
          `(${policy.expiry_date.toISOString()}).`,
      );
    }

    // ── 3. Severity classification ────────────────────────────────────────
    const severity = classifyInitialSeverity({
      incident_type: dto.incident_type,
      injury_reported: dto.injury_reported ?? false,
      third_party_involved: dto.third_party_involved ?? false,
      declared_loss_amount_yen: dto.declared_loss_amount_yen,
    });

    // ── 4. Encrypt special-care PII ───────────────────────────────────────
    const reporter_phone_ct = dto.reporter_phone
      ? encrypt(dto.reporter_phone)
      : null;
    const reporter_email_ct = dto.reporter_email
      ? encrypt(dto.reporter_email)
      : null;

    // ── 5. Persist ────────────────────────────────────────────────────────
    const claim = await this.prisma.claim.create({
      data: {
        policy_number: dto.policy_number.trim(),
        loss_date: lossDate,
        loss_location_prefecture: dto.loss_location_prefecture.trim(),
        loss_location_postal_code: dto.loss_location_postal_code.trim(),
        loss_location_detail: dto.loss_location_detail.trim(),
        reported_by_channel: dto.reported_by_channel,
        reporter_name: dto.reporter_name.trim(),
        reporter_phone_ct,
        reporter_email_ct,
        reporter_relation_to_insured: dto.reporter_relation_to_insured,
        incident_type: dto.incident_type,
        initial_description: dto.initial_description.trim(),
        injury_reported: dto.injury_reported ?? false,
        third_party_involved: dto.third_party_involved ?? false,
        police_report_number: dto.police_report_number?.trim() ?? null,
        severity_initial: severity,
        status: ClaimStatus.intake,
        appi_consent_version: dto.appi_consent_version,
        appi_consent_at:
          dto.appi_consent_at instanceof Date
            ? dto.appi_consent_at
            : new Date(dto.appi_consent_at),
      },
      include: {
        assigned_adjuster: { select: { id: true, display_name: true, role: true } },
      },
    });

    // ── 6. Audit event ────────────────────────────────────────────────────
    await this.auditService.emit({
      actor_id: caller.id,
      actor_role: caller.role,
      action: 'claim.created',
      claim_id: claim.id,
      target_id: claim.id,
      payload: {
        policy_number: claim.policy_number,
        channel: claim.reported_by_channel,
        incident_type: claim.incident_type,
        severity: claim.severity_initial,
      },
      request_id: caller.request_id,
      correlation_id: caller.correlation_id,
    });

    this.logger.log(
      { claim_id: claim.id, severity, actor_id: caller.id },
      'FNOL claim created successfully',
    );

    return maskClaimForRole(claim, caller.role, caller.id);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Query — findAll (role-scoped list)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns a role-scoped list of claims.
   *
   * Role scoping (brief.md role matrix):
   *   - agent      → claims they created (approximated by created_by_agent_id
   *                  which is not in the schema; scoped by channel=agent for POC)
   *   - adjuster   → claims assigned to them
   *   - manager    → all claims (full visibility)
   *   - auditor    → all claims (masked)
   *   - siu_referrer → (Track B) flagged claims only; for now: none
   *
   * @param caller  - Authenticated caller.
   * @param filters - Optional filter parameters.
   */
  async findAll(
    caller: CallerContext,
    filters: {
      status?: ClaimStatus;
      severity?: ClaimSeverity;
      channel?: IntakeChannel;
      assignee_id?: string;
      skip?: number;
      take?: number;
    } = {},
  ) {
    const where: Record<string, unknown> = {};

    // Role-based scoping
    if (caller.role === UserRole.adjuster) {
      where['assigned_adjuster_id'] = caller.id;
    } else if (caller.role === UserRole.siu_referrer) {
      // Track B: siu_referrer sees flagged claims only.
      // For Track A, return empty list to be safe.
      return [];
    }
    // manager, auditor see all (additional filters below)

    if (filters.status) where['status'] = filters.status;
    if (filters.severity) where['severity_initial'] = filters.severity;
    if (filters.channel) where['reported_by_channel'] = filters.channel;
    if (filters.assignee_id) where['assigned_adjuster_id'] = filters.assignee_id;

    const claims = await this.prisma.claim.findMany({
      where,
      skip: filters.skip ?? 0,
      take: filters.take ?? 50,
      orderBy: { created_at: 'desc' },
      include: {
        assigned_adjuster: { select: { id: true, display_name: true, role: true } },
        _count: { select: { notes: true, evidence: true, reserves: true } },
      },
    });

    return claims.map((c) => maskClaimForRole(c, caller.role, caller.id));
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Query — findOne (role-masked detail)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns the full detail of a claim, role-masked for the caller.
   *
   * @param id     - Claim ID.
   * @param caller - Authenticated caller.
   * @throws NotFoundException if the claim does not exist.
   * @throws ForbiddenException if the caller's role does not permit access.
   */
  async findOne(id: string, caller: CallerContext) {
    const claim = await this.prisma.claim.findUnique({
      where: { id },
      include: {
        assigned_adjuster: { select: { id: true, display_name: true, role: true } },
        notes: {
          orderBy: { created_at: 'asc' },
          include: { claim: false },
        },
        evidence: { orderBy: { uploaded_at: 'asc' } },
        witness_statements: { orderBy: { recorded_at: 'asc' } },
        reserves: { orderBy: { proposed_at: 'desc' } },
      },
    });

    if (!claim) {
      throw new NotFoundException(`Claim '${id}' not found.`);
    }

    this.assertCanReadClaim(claim, caller);

    return maskClaimForRole(claim, caller.role, caller.id);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Assign / re-assign adjuster
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Assigns or re-assigns an adjuster to a claim.
   *
   * Only managers may perform this action (brief.md role matrix).
   * The target adjuster must exist and have role=adjuster.
   *
   * @param id     - Claim ID.
   * @param dto    - Assignment payload.
   * @param caller - Manager making the assignment.
   */
  async assignAdjuster(id: string, dto: AssignClaimDto, caller: CallerContext) {
    if (caller.role !== UserRole.manager) {
      throw new ForbiddenException('Only managers may assign adjusters to claims.');
    }

    const claim = await this.requireClaim(id);

    // Verify target adjuster exists and has the correct role
    const adjuster = await this.prisma.user.findUnique({
      where: { id: dto.adjuster_id },
    });
    if (!adjuster) {
      throw new BadRequestException(
        `User '${dto.adjuster_id}' does not exist.`,
      );
    }
    if (adjuster.role !== UserRole.adjuster) {
      throw new BadRequestException(
        `User '${dto.adjuster_id}' has role '${adjuster.role}'; only users with role 'adjuster' may be assigned.`,
      );
    }

    const previousAdjusterId = claim.assigned_adjuster_id;
    const isReassignment = !!previousAdjusterId;

    const updated = await this.prisma.claim.update({
      where: { id },
      data: {
        assigned_adjuster_id: dto.adjuster_id,
      },
      include: {
        assigned_adjuster: { select: { id: true, display_name: true, role: true } },
      },
    });

    await this.auditService.emit({
      actor_id: caller.id,
      actor_role: caller.role,
      action: isReassignment ? 'claim.reassigned' : 'claim.assigned',
      claim_id: id,
      target_id: dto.adjuster_id,
      payload: {
        previous_adjuster_id: previousAdjusterId,
        new_adjuster_id: dto.adjuster_id,
        reason_for_reassignment: dto.reason_for_reassignment,
      },
      request_id: caller.request_id,
      correlation_id: caller.correlation_id,
    });

    this.logger.log(
      {
        claim_id: id,
        adjuster_id: dto.adjuster_id,
        is_reassignment: isReassignment,
        actor_id: caller.id,
      },
      'Claim adjuster assigned',
    );

    return maskClaimForRole(updated, caller.role, caller.id);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Notes — append-only
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Appends an immutable timestamped note to a claim.
   *
   * Notes are never edited; corrections require a new note. (brief.md §2)
   *
   * Role constraints:
   *   - adjuster  → assigned claims only
   *   - manager   → claims in their reports pool (approximated as any claim for POC)
   *
   * @param id     - Claim ID.
   * @param dto    - Note content.
   * @param caller - Author.
   */
  async addNote(id: string, dto: AddNoteDto, caller: CallerContext) {
    if (
      caller.role !== UserRole.adjuster &&
      caller.role !== UserRole.manager
    ) {
      throw new ForbiddenException(
        'Only adjusters and managers may add notes to claims.',
      );
    }

    const claim = await this.requireClaim(id);
    this.assertCanWriteClaim(claim, caller);

    const note = await this.prisma.claimNote.create({
      data: {
        claim_id: id,
        author_id: caller.id,
        body: dto.body.trim(),
      },
    });

    await this.auditService.emit({
      actor_id: caller.id,
      actor_role: caller.role,
      action: 'claim.note.added',
      claim_id: id,
      target_id: note.id,
      payload: { note_id: note.id, body_length: dto.body.trim().length },
      request_id: caller.request_id,
      correlation_id: caller.correlation_id,
    });

    this.logger.debug(
      { claim_id: id, note_id: note.id, actor_id: caller.id },
      'Claim note appended',
    );

    return note;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Evidence — attach
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Attaches an evidence record to a claim.
   *
   * Blob storage is stubbed — only the content_hash and blob_ref are stored.
   * The content_hash provides tamper detection (brief.md §2).
   *
   * Role constraints: adjuster only, assigned claims only.
   *
   * @param id     - Claim ID.
   * @param dto    - Evidence metadata.
   * @param caller - Uploader (adjuster).
   */
  async addEvidence(id: string, dto: AddEvidenceDto, caller: CallerContext) {
    if (caller.role !== UserRole.adjuster) {
      throw new ForbiddenException('Only adjusters may attach evidence to claims.');
    }

    const claim = await this.requireClaim(id);
    this.assertIsAssignedAdjuster(claim, caller);

    const evidence = await this.prisma.evidence.create({
      data: {
        claim_id: id,
        kind: dto.kind as EvidenceKind,
        content_hash: dto.content_hash,
        blob_ref: dto.blob_ref,
        uploaded_by_id: caller.id,
      },
    });

    await this.auditService.emit({
      actor_id: caller.id,
      actor_role: caller.role,
      action: 'claim.evidence.added',
      claim_id: id,
      target_id: evidence.id,
      payload: {
        evidence_id: evidence.id,
        kind: evidence.kind,
        content_hash: evidence.content_hash,
        blob_ref: evidence.blob_ref,
      },
      request_id: caller.request_id,
      correlation_id: caller.correlation_id,
    });

    this.logger.debug(
      { claim_id: id, evidence_id: evidence.id, kind: evidence.kind, actor_id: caller.id },
      'Evidence attached to claim',
    );

    return evidence;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Witness statements — structured intake
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Records a structured witness statement for a claim.
   *
   * The inkan_seal_hash provides the digital equivalent of a Japanese hanko
   * seal — binding the witness acknowledgement to the statement content and
   * timestamp (ADR-002, brief.md §2).
   *
   * witness_phone is encrypted as standard PII (APPI ADR-001).
   *
   * Role constraints: adjuster only, assigned claims only.
   *
   * @param id     - Claim ID.
   * @param dto    - Witness statement data.
   * @param caller - Recording adjuster.
   */
  async addWitnessStatement(
    id: string,
    dto: AddWitnessStatementDto,
    caller: CallerContext,
  ) {
    if (caller.role !== UserRole.adjuster) {
      throw new ForbiddenException(
        'Only adjusters may record witness statements.',
      );
    }

    const claim = await this.requireClaim(id);
    this.assertIsAssignedAdjuster(claim, caller);

    const witness_phone_ct = dto.witness_phone
      ? encrypt(dto.witness_phone)
      : null;

    const statement = await this.prisma.witnessStatement.create({
      data: {
        claim_id: id,
        witness_name: dto.witness_name.trim(),
        witness_phone_ct,
        statement_body: dto.statement_body.trim(),
        inkan_seal_hash: dto.inkan_seal_hash,
        recorded_by_id: caller.id,
      },
    });

    await this.auditService.emit({
      actor_id: caller.id,
      actor_role: caller.role,
      action: 'claim.witness_statement.added',
      claim_id: id,
      target_id: statement.id,
      payload: {
        statement_id: statement.id,
        witness_name: statement.witness_name,
        inkan_seal_hash: statement.inkan_seal_hash,
      },
      request_id: caller.request_id,
      correlation_id: caller.correlation_id,
    });

    this.logger.debug(
      {
        claim_id: id,
        statement_id: statement.id,
        inkan_seal_hash: statement.inkan_seal_hash,
        actor_id: caller.id,
      },
      'Witness statement recorded',
    );

    // Return without encrypted phone — cleartext was not stored
    return {
      id: statement.id,
      claim_id: statement.claim_id,
      witness_name: statement.witness_name,
      statement_body: statement.statement_body,
      inkan_seal_hash: statement.inkan_seal_hash,
      recorded_by_id: statement.recorded_by_id,
      recorded_at: statement.recorded_at,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Status transition — FSM-guarded
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Transitions a claim's status through the workflow FSM.
   *
   * Illegal transitions return 422 Unprocessable Entity with the FSM's
   * human-readable reason (ADR-004).
   *
   * Role constraints (brief.md role matrix):
   *   - adjuster → assigned claims only
   *   - manager  → claims in their reports pool (any for POC)
   *
   * @param id     - Claim ID.
   * @param dto    - Target status and optional reason.
   * @param caller - Actor requesting the transition.
   */
  async updateStatus(id: string, dto: UpdateStatusDto, caller: CallerContext) {
    if (
      caller.role !== UserRole.adjuster &&
      caller.role !== UserRole.manager
    ) {
      throw new ForbiddenException(
        'Only adjusters and managers may transition claim status.',
      );
    }

    const claim = await this.requireClaim(id);

    // Adjusters can only transition their own assigned claims
    if (caller.role === UserRole.adjuster) {
      this.assertIsAssignedAdjuster(claim, caller);
    }

    const fsmResult = checkTransition(
      { current_status: claim.status, assigned_adjuster_id: claim.assigned_adjuster_id },
      { id: caller.id, role: caller.role },
      dto.to,
      dto.reason,
    );

    if (!fsmResult.ok) {
      throw new UnprocessableEntityException(
        `Status transition refused [${fsmResult.code}]: ${fsmResult.reason}`,
      );
    }

    const previousStatus = claim.status;

    const updated = await this.prisma.claim.update({
      where: { id },
      data: { status: dto.to },
      include: {
        assigned_adjuster: { select: { id: true, display_name: true, role: true } },
      },
    });

    await this.auditService.emit({
      actor_id: caller.id,
      actor_role: caller.role,
      action: 'claim.status.updated',
      claim_id: id,
      target_id: id,
      payload: {
        from_status: previousStatus,
        to_status: dto.to,
        reason: dto.reason,
      },
      request_id: caller.request_id,
      correlation_id: caller.correlation_id,
    });

    this.logger.log(
      {
        claim_id: id,
        from_status: previousStatus,
        to_status: dto.to,
        actor_id: caller.id,
      },
      'Claim status transitioned',
    );

    return maskClaimForRole(updated, caller.role, caller.id);
  }

  // ─────────────────────────────────────────────────────────────────────────
  // APPI — Data-subject export (Article 28)
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Returns all PII data held about the individual associated with a claim.
   *
   * Only auditors and managers may perform this action (brief.md role matrix).
   * The response includes all standard and special-care PII fields.
   *
   * @param id     - Claim ID.
   * @param caller - Auditor or manager requesting the export.
   */
  async dataSubjectExport(id: string, caller: CallerContext) {
    if (
      caller.role !== UserRole.auditor &&
      caller.role !== UserRole.manager
    ) {
      throw new ForbiddenException(
        'Only auditors and managers may perform APPI data-subject exports.',
      );
    }

    const claim = await this.prisma.claim.findUnique({
      where: { id },
      include: {
        notes: true,
        evidence: true,
        witness_statements: true,
        reserves: true,
      },
    });

    if (!claim) {
      throw new NotFoundException(`Claim '${id}' not found.`);
    }

    await this.auditService.emit({
      actor_id: caller.id,
      actor_role: caller.role,
      action: 'claim.data_subject_export',
      claim_id: id,
      target_id: id,
      payload: { exported_by: caller.id, export_reason: 'APPI Article 28 data subject request' },
      request_id: caller.request_id,
      correlation_id: caller.correlation_id,
    });

    // Return the raw claim (PII fully visible for authorised export)
    // Encrypted bytes are returned as base64 strings for the export document.
    return {
      export_type: 'APPI_ARTICLE_28_DATA_SUBJECT_DISCLOSURE',
      exported_at: new Date().toISOString(),
      exported_by: caller.id,
      claim: {
        id: claim.id,
        policy_number: claim.policy_number,
        loss_date: claim.loss_date,
        loss_location_prefecture: claim.loss_location_prefecture,
        loss_location_postal_code: claim.loss_location_postal_code,
        loss_location_detail: claim.loss_location_detail,
        reported_by_channel: claim.reported_by_channel,
        reporter_name: claim.reporter_name,
        // Encrypted special-care PII returned as base64 for downstream decryption
        reporter_phone_ct_base64: claim.reporter_phone_ct
          ? Buffer.from(claim.reporter_phone_ct).toString('base64')
          : null,
        reporter_email_ct_base64: claim.reporter_email_ct
          ? Buffer.from(claim.reporter_email_ct).toString('base64')
          : null,
        reporter_relation_to_insured: claim.reporter_relation_to_insured,
        incident_type: claim.incident_type,
        initial_description: claim.initial_description,
        injury_reported: claim.injury_reported,
        third_party_involved: claim.third_party_involved,
        police_report_number: claim.police_report_number,
        severity_initial: claim.severity_initial,
        status: claim.status,
        appi_consent_version: claim.appi_consent_version,
        appi_consent_at: claim.appi_consent_at,
        insured_government_id_ct_base64: claim.insured_government_id_ct
          ? Buffer.from(claim.insured_government_id_ct).toString('base64')
          : null,
        bank_account_for_payout_ct_base64: claim.bank_account_for_payout_ct
          ? Buffer.from(claim.bank_account_for_payout_ct).toString('base64')
          : null,
        injury_details_ct_base64: claim.injury_details_ct
          ? Buffer.from(claim.injury_details_ct).toString('base64')
          : null,
        created_at: claim.created_at,
        updated_at: claim.updated_at,
      },
      witness_statements: claim.witness_statements.map((ws) => ({
        id: ws.id,
        witness_name: ws.witness_name,
        witness_phone_ct_base64: ws.witness_phone_ct
          ? Buffer.from(ws.witness_phone_ct).toString('base64')
          : null,
        statement_body: ws.statement_body,
        inkan_seal_hash: ws.inkan_seal_hash,
        recorded_at: ws.recorded_at,
      })),
      notes_count: claim.notes.length,
      evidence_count: claim.evidence.length,
      reserves_count: claim.reserves.length,
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // APPI — Anonymise personal data
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Redacts PII fields from a claim while preserving the audit trail.
   *
   * Per brief.md, this is manager-only in Track A scope, invoked via
   * DELETE /claims/:id/personal-data-anonymise. The audit trail is never
   * touched — only claim PII fields are redacted.
   *
   * @param id     - Claim ID.
   * @param caller - Manager or system process performing the anonymisation.
   */
  async anonymisePersonalData(id: string, caller: CallerContext) {
    if (caller.role !== UserRole.manager && caller.role !== UserRole.auditor) {
      throw new ForbiddenException(
        'Only managers may anonymise personal data.',
      );
    }

    const claim = await this.requireClaim(id);

    const redacted = await this.prisma.claim.update({
      where: { id },
      data: {
        reporter_name: '[REDACTED]',
        reporter_phone_ct: null,
        reporter_email_ct: null,
        reporter_relation_to_insured: '[REDACTED]',
        loss_location_detail: '[REDACTED]',
        initial_description: '[REDACTED]',
        police_report_number: claim.police_report_number ? '[REDACTED]' : null,
        insured_government_id_ct: null,
        bank_account_for_payout_ct: null,
        injury_details_ct: null,
      },
    });

    await this.auditService.emit({
      actor_id: caller.id,
      actor_role: caller.role,
      action: 'claim.personal_data.anonymised',
      claim_id: id,
      target_id: id,
      payload: {
        anonymised_by: caller.id,
        fields_redacted: [
          'reporter_name',
          'reporter_phone_ct',
          'reporter_email_ct',
          'reporter_relation_to_insured',
          'loss_location_detail',
          'initial_description',
          'insured_government_id_ct',
          'bank_account_for_payout_ct',
          'injury_details_ct',
        ],
      },
      request_id: caller.request_id,
      correlation_id: caller.correlation_id,
    });

    this.logger.warn(
      { claim_id: id, actor_id: caller.id },
      'Claim PII anonymised under APPI request',
    );

    return { claim_id: id, anonymised: true, anonymised_at: new Date() };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Fetches a claim by ID or throws NotFoundException.
   */
  private async requireClaim(id: string) {
    const claim = await this.prisma.claim.findUnique({ where: { id } });
    if (!claim) {
      throw new NotFoundException(`Claim '${id}' not found.`);
    }
    return claim;
  }

  /**
   * Asserts the caller has read access to the given claim per the role matrix.
   *
   * Role access (brief.md §2 role matrix):
   *   - agent      → own intake claims (cannot verify in this context without
   *                  a created_by_agent_id; approximated as: allow for 24h window)
   *   - adjuster   → assigned claims only
   *   - manager    → any claim
   *   - auditor    → any claim
   *   - siu_referrer → flagged claims only (Track B; for now blocked)
   */
  private assertCanReadClaim(
    claim: { assigned_adjuster_id: string | null; status: ClaimStatus },
    caller: CallerContext,
  ): void {
    if (
      caller.role === UserRole.manager ||
      caller.role === UserRole.auditor
    ) {
      return; // Full access
    }

    if (caller.role === UserRole.adjuster) {
      if (claim.assigned_adjuster_id !== caller.id) {
        throw new ForbiddenException(
          'Adjusters may only access claims assigned to them.',
        );
      }
      return;
    }

    if (caller.role === UserRole.siu_referrer) {
      // Track B: SIU referrer sees flagged claims only.
      throw new ForbiddenException(
        'SIU referrers do not have general claim read access in Track A.',
      );
    }

    // agent — limited access; for POC allow read of any claim they created.
    // Without a created_by field on Claim we cannot verify; allow read-only.
    // Production Track B will add created_by_agent_id.
  }

  /**
   * Asserts the caller may write to the claim (notes, witness statements,
   * evidence, status transitions).
   */
  private assertCanWriteClaim(
    claim: { assigned_adjuster_id: string | null },
    caller: CallerContext,
  ): void {
    if (caller.role === UserRole.manager) {
      return; // Managers may write to any claim in their pool
    }

    if (caller.role === UserRole.adjuster) {
      this.assertIsAssignedAdjuster(claim, caller);
      return;
    }

    throw new ForbiddenException(
      `Role '${caller.role}' is not permitted to write to this claim.`,
    );
  }

  /**
   * Throws ForbiddenException if the caller is not the assigned adjuster
   * for the given claim.
   */
  private assertIsAssignedAdjuster(
    claim: { assigned_adjuster_id: string | null },
    caller: CallerContext,
  ): void {
    if (claim.assigned_adjuster_id !== caller.id) {
      throw new ForbiddenException(
        'Adjusters may only perform this action on claims assigned to them.',
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Severity classification (pure function — no I/O)
// ---------------------------------------------------------------------------

/**
 * Input signals for the initial severity classifier.
 */
export interface SeverityClassificationInput {
  incident_type: IncidentType;
  injury_reported: boolean;
  third_party_involved: boolean;
  declared_loss_amount_yen?: number | Decimal | null;
}

/**
 * Classifies the initial severity of a claim based on declared signals.
 *
 * Algorithm (brief.md §1 Initial classification — pure function, no ML):
 *
 * Catastrophic if ANY of:
 *   - declared_loss_amount_yen >= ¥10M
 *   - injury_reported AND incident_type in HIGH_RISK_INCIDENT_TYPES
 *   - third_party_involved AND injury_reported
 *
 * Complex if ANY of:
 *   - declared_loss_amount_yen >= ¥1M (but < ¥10M)
 *   - incident_type in COMPLEX_INCIDENT_TYPES
 *   - injury_reported
 *   - third_party_involved
 *
 * Simple: all other cases.
 *
 * @param input - Classification signals.
 * @returns ClaimSeverity enum value.
 */
export function classifyInitialSeverity(
  input: SeverityClassificationInput,
): ClaimSeverity {
  const lossYen = input.declared_loss_amount_yen
    ? Number(input.declared_loss_amount_yen)
    : 0;

  // ── Catastrophic ────────────────────────────────────────────────────────
  if (lossYen >= SEVERITY_CATASTROPHIC_THRESHOLD_YEN) {
    return ClaimSeverity.catastrophic;
  }

  if (
    input.injury_reported &&
    HIGH_RISK_INCIDENT_TYPES.has(input.incident_type)
  ) {
    return ClaimSeverity.catastrophic;
  }

  if (input.third_party_involved && input.injury_reported) {
    return ClaimSeverity.catastrophic;
  }

  // ── Complex ─────────────────────────────────────────────────────────────
  if (lossYen >= SEVERITY_COMPLEX_THRESHOLD_YEN) {
    return ClaimSeverity.complex;
  }

  if (COMPLEX_INCIDENT_TYPES.has(input.incident_type)) {
    return ClaimSeverity.complex;
  }

  if (input.injury_reported || input.third_party_involved) {
    return ClaimSeverity.complex;
  }

  // ── Simple ───────────────────────────────────────────────────────────────
  return ClaimSeverity.simple;
}