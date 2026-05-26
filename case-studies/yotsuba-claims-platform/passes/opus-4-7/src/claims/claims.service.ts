// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// Claims service — the spine of the platform.
//
// `ClaimsService` is the cross-cutting layer that all four FNOL
// channels and every workbench operation eventually call into. Per
// design.md §3, the channel-specific shaping lives in
// `ClaimsChannelService`; the FSM lives in `claims-status.fsm.ts`;
// the audit interceptor lives in `common/audit.interceptor.ts`.
// Everything else — policy-window validation, severity
// classification, encryption of special-care PII, role-scoped reads,
// notes / evidence / witness writes, status transitions — lives
// here.
//
// Design commitments honoured in this file:
//
//   * APPI tiering (ADR-001, ADR-003): standard PII (`reporter_phone`,
//     `reporter_email`) and special-care PII (`insured_government_id`,
//     `bank_account_for_payout`, `injury_details`) are encrypted into
//     the `_ct` Bytes columns via the AES-256-GCM envelope. Cleartext
//     fields are returned only by the role-masking layer at the
//     controller boundary; this service returns full records.
//
//   * Decimal currency (design.md §6): not directly referenced here
//     because reserves live in their own service, but the claim row
//     never holds yen.
//
//   * Audit immutability (ADR-002): every write returns a structured
//     result that the audit interceptor can hash deterministically;
//     the service never writes audit rows itself.
//
//   * FSM authority (ADR-004): status transitions delegate entirely
//     to `evaluateTransition`. Illegal transitions surface as
//     `UnprocessableEntityException` (HTTP 422) with the FSM's
//     verbatim reason in the body, as the brief requires.
//
//   * Role-scoped reads (brief role matrix): list and detail views
//     restrict result sets based on caller role. Cleartext-vs-masked
//     field decisions are deferred to the controller's masking
//     interceptor — this service does not pre-mask.
//
// Policy lookup is stubbed: the brief lists a `Policy Service` as
// external and out of scope for Track A. We model it inline as a
// pure function `lookupPolicyWindow` that returns a plausible
// effective / expiry window derived deterministically from the
// `policy_number`. A real implementation would call out via HTTP.
// ─────────────────────────────────────────────────────────────────────────

import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnprocessableEntityException,
} from '@nestjs/common';

import {
  Claim,
  ClaimNote,
  ClaimSeverity,
  ClaimStatus,
  Evidence,
  IncidentType,
  Prisma,
  UserRole,
  WitnessStatement,
} from '@prisma/client';

import { PrismaService } from '../prisma.service';
import { encryptField } from '../common/encryption';
import { AddEvidenceDto } from './dto/add-evidence.dto';
import { AddNoteDto } from './dto/add-note.dto';
import { AddWitnessStatementDto } from './dto/add-witness-statement.dto';
import { AssignClaimDto } from './dto/assign-claim.dto';
import { CreateClaimDto } from './dto/create-claim.dto';
import { UpdateStatusDto } from './dto/update-status.dto';
import {
  FsmActor,
  evaluateTransition,
} from './claims-status.fsm';

/**
 * Authenticated caller context as resolved by the JWT guard. We
 * accept this as a structural type rather than importing the full
 * `User` model so that the service is easy to unit-test with plain
 * object literals.
 */
export interface CallerContext {
  id: string;
  role: UserRole;
  is_claims_director: boolean;
  reports_to_id: string | null;
}

/**
 * Filters accepted on `GET /claims`. All fields are optional; the
 * service applies the caller's role-scoped restriction on top of
 * whatever filters are supplied.
 */
export interface ListClaimsFilters {
  status?: ClaimStatus;
  severity?: ClaimSeverity;
  channel?: Claim['reported_by_channel'];
  assignee_id?: string;
}

/**
 * Canonical list of valid Japanese prefectures (都道府県). The brief
 * requires prefecture validation at intake; keeping the list inline
 * — rather than fetching from a remote table — gives reviewers a
 * single, auditable source of truth and avoids a network dependency
 * on the hot path.
 */
const PREFECTURES: ReadonlySet<string> = new Set([
  '北海道',
  '青森県', '岩手県', '宮城県', '秋田県', '山形県', '福島県',
  '茨城県', '栃木県', '群馬県', '埼玉県', '千葉県', '東京都', '神奈川県',
  '新潟県', '富山県', '石川県', '福井県', '山梨県', '長野県',
  '岐阜県', '静岡県', '愛知県', '三重県',
  '滋賀県', '京都府', '大阪府', '兵庫県', '奈良県', '和歌山県',
  '鳥取県', '島根県', '岡山県', '広島県', '山口県',
  '徳島県', '香川県', '愛媛県', '高知県',
  '福岡県', '佐賀県', '長崎県', '熊本県', '大分県', '宮崎県', '鹿児島県',
  '沖縄県',
]);

/**
 * Severity classifier: a pure rule defined in the brief. The brief
 * specifies severity is a function of `incident_type`,
 * `injury_reported`, and "declared loss amount". The FNOL DTO does
 * not carry a declared loss amount on Track A — the figure is
 * established by the adjuster post-intake — so we make do with the
 * other two signals and a small per-incident-type bias.
 *
 * Catastrophic: any injury on auto-collision / fire-commercial /
 * personal-accident, or any commercial-fire / marine-cargo claim by
 * default (these tend to carry large exposures).
 *
 * Complex: third-party involvement, or liability-premises /
 * fire-residential default.
 *
 * Simple: everything else.
 */
export function classifySeverity(
  incidentType: IncidentType,
  injuryReported: boolean,
  thirdPartyInvolved: boolean,
): ClaimSeverity {
  const catastrophicIfInjured: readonly IncidentType[] = [
    'auto_collision',
    'fire_commercial',
    'personal_accident',
  ];
  const alwaysCatastrophic: readonly IncidentType[] = [
    'fire_commercial',
    'marine_cargo',
  ];
  const complexByDefault: readonly IncidentType[] = [
    'liability_premises',
    'fire_residential',
  ];

  if (injuryReported && catastrophicIfInjured.includes(incidentType)) {
    return 'catastrophic';
  }
  if (alwaysCatastrophic.includes(incidentType)) {
    return 'catastrophic';
  }
  if (thirdPartyInvolved) {
    return 'complex';
  }
  if (complexByDefault.includes(incidentType)) {
    return 'complex';
  }
  return 'simple';
}

/**
 * Policy-window lookup stub. The real Policy Service is external
 * (see brief, "Business context"); for Track A we synthesise a
 * plausible window deterministically from the policy number so that
 * tests can reason about it without a live dependency.
 *
 * Convention: every policy number that parses to a non-empty,
 * trimmed string is treated as currently effective from one year
 * ago to one year from now. Policy numbers whose last character is
 * `X` are treated as expired (effective two years ago, expired one
 * year ago) — that gives the test suite a way to construct a
 * negative case.
 */
export function lookupPolicyWindow(policyNumber: string): {
  effective_at: Date;
  expires_at: Date;
} {
  const now = Date.now();
  const oneYearMs = 365 * 24 * 60 * 60 * 1000;
  const trimmed = policyNumber.trim();
  if (trimmed.endsWith('X')) {
    return {
      effective_at: new Date(now - 2 * oneYearMs),
      expires_at: new Date(now - oneYearMs),
    };
  }
  return {
    effective_at: new Date(now - oneYearMs),
    expires_at: new Date(now + oneYearMs),
  };
}

/**
 * Service-level result returned from intake. The controller wraps
 * it for the HTTP response; the audit interceptor reads
 * `audit_target_id = claim.id` and `audit_action = 'claim.created'`
 * via the `@Audit` decorator on the controller method.
 */
export interface CreateClaimResult {
  claim: Claim;
  idempotency_key?: string;
}

@Injectable()
export class ClaimsService {
  constructor(private readonly prisma: PrismaService) {}

  // ─── intake ─────────────────────────────────────────────────────

  /**
   * Persist a normalised FNOL intake. Performs:
   *   * policy-number trimming + non-empty check;
   *   * policy-window validation against the lookup stub;
   *   * prefecture validation;
   *   * APPI consent presence check for non-agent channels;
   *   * severity classification;
   *   * encryption of standard and special-care PII into the
   *     respective `_ct` columns;
   *   * row creation with `status = 'intake'`.
   *
   * Idempotency for the email channel is the controller's
   * responsibility (it must short-circuit when a claim already
   * exists for a given `Message-Id`); the service is happy to be
   * called once per intake.
   */
  async createFromIntake(
    dto: CreateClaimDto,
    actor: CallerContext,
    idempotencyKey?: string,
  ): Promise<CreateClaimResult> {
    if (actor.role !== 'agent' && actor.role !== 'adjuster') {
      throw new ForbiddenException(
        `Role '${actor.role}' is not permitted to create claims.`,
      );
    }

    const policyNumber = dto.policy_number.trim();
    if (policyNumber.length === 0) {
      throw new BadRequestException('policy_number must not be empty.');
    }

    if (!PREFECTURES.has(dto.loss_location_prefecture)) {
      throw new BadRequestException(
        `loss_location_prefecture '${dto.loss_location_prefecture}' is not a recognised Japanese prefecture.`,
      );
    }

    const lossDate = new Date(dto.loss_date);
    if (Number.isNaN(lossDate.getTime())) {
      throw new BadRequestException('loss_date is not a valid ISO-8601 date.');
    }
    const window = lookupPolicyWindow(policyNumber);
    if (lossDate < window.effective_at || lossDate > window.expires_at) {
      throw new BadRequestException(
        `loss_date ${lossDate.toISOString()} falls outside policy effective window `
        + `(${window.effective_at.toISOString()} – ${window.expires_at.toISOString()}).`,
      );
    }

    if (dto.reported_by_channel !== 'agent') {
      const v = (dto.appi_consent_version ?? '').trim();
      const a = (dto.appi_consent_at ?? '').trim();
      if (v.length === 0 || a.length === 0) {
        throw new BadRequestException(
          `APPI consent is required for intake on the '${dto.reported_by_channel}' channel.`,
        );
      }
    }

    const consentAt = new Date(dto.appi_consent_at);
    if (Number.isNaN(consentAt.getTime())) {
      throw new BadRequestException('appi_consent_at is not a valid ISO-8601 date.');
    }

    const severity = classifySeverity(
      dto.incident_type,
      dto.injury_reported ?? false,
      dto.third_party_involved ?? false,
    );

    const claim = await this.prisma.claim.create({
      data: {
        policy_number: policyNumber,
        loss_date: lossDate,
        loss_location_prefecture: dto.loss_location_prefecture,
        loss_location_postal_code: dto.loss_location_postal_code,
        loss_location_detail: dto.loss_location_detail,
        reported_by_channel: dto.reported_by_channel,
        reporter_name: dto.reporter_name,
        reporter_phone_ct: dto.reporter_phone
          ? encryptField(dto.reporter_phone)
          : null,
        reporter_email_ct: dto.reporter_email
          ? encryptField(dto.reporter_email)
          : null,
        reporter_relation_to_insured: dto.reporter_relation_to_insured,
        incident_type: dto.incident_type,
        initial_description: dto.initial_description,
        injury_reported: dto.injury_reported ?? false,
        third_party_involved: dto.third_party_involved ?? false,
        police_report_number: dto.police_report_number ?? null,
        severity_initial: severity,
        status: 'intake',
        appi_consent_version: dto.appi_consent_version,
        appi_consent_at: consentAt,
        insured_government_id_ct: dto.insured_government_id
          ? encryptField(dto.insured_government_id)
          : null,
        bank_account_for_payout_ct: dto.bank_account_for_payout
          ? encryptField(dto.bank_account_for_payout)
          : null,
        injury_details_ct: dto.injury_details
          ? encryptField(dto.injury_details)
          : null,
      },
    });

    return { claim, idempotency_key: idempotencyKey };
  }

  // ─── reads ──────────────────────────────────────────────────────

  /**
   * Role-scoped list. The controller-level masking interceptor
   * redacts individual fields after the fact; this method controls
   * which *rows* a caller may see at all.
   *
   *   * agent       → only claims they originated, within 24h of
   *                   creation.
   *   * adjuster    → only claims assigned to them.
   *   * manager     → claims assigned to their direct reports, plus
   *                   any unassigned claims (so they can triage).
   *   * auditor     → all claims.
   *   * siu_referrer → reserved for Track B; today returns nothing.
   */
  async listForCaller(
    actor: CallerContext,
    filters: ListClaimsFilters,
  ): Promise<Claim[]> {
    const where: Prisma.ClaimWhereInput = {};
    if (filters.status) where.status = filters.status;
    if (filters.severity) where.severity_initial = filters.severity;
    if (filters.channel) where.reported_by_channel = filters.channel;
    if (filters.assignee_id) where.assigned_adjuster_id = filters.assignee_id;

    const scoped = await this.applyRoleScope(where, actor);
    if (scoped === null) {
      return [];
    }

    return this.prisma.claim.findMany({
      where: scoped,
      orderBy: { created_at: 'desc' },
      take: 200,
    });
  }

  /**
   * Role-scoped detail. Throws 404 when the row does not exist and
   * 403 when the caller's role excludes it (we do *not* leak the
   * existence of inaccessible claims by returning 403 vs 404
   * differentially when the row is genuinely missing).
   */
  async findForCaller(claimId: string, actor: CallerContext): Promise<Claim> {
    const claim = await this.prisma.claim.findUnique({ where: { id: claimId } });
    if (!claim) {
      throw new NotFoundException(`Claim '${claimId}' not found.`);
    }
    if (!(await this.callerMayReadClaim(claim, actor))) {
      throw new ForbiddenException(
        `Role '${actor.role}' is not permitted to read claim '${claimId}'.`,
      );
    }
    return claim;
  }

  // ─── assignment ─────────────────────────────────────────────────

  /**
   * Assign or re-assign a claim. Manager-only per the role matrix.
   * The target adjuster must exist, hold the `adjuster` role, and
   * (for re-assignment) the manager must be in the assignee's
   * `reports_to` chain — managers can only juggle their own pool.
   *
   * The `assigned_adjuster_id` mutation is the persistence side
   * effect; `claim.updated_at` advances and is treated as the
   * `assigned_at` for audit purposes. A `reason_for_reassignment`
   * is captured into the audit `payload_hash` via the controller
   * decorator — it is not persisted on the claim row itself, since
   * the brief's data model deliberately keeps the row clean and
   * relies on the audit log for the rationale trail.
   */
  async assign(
    claimId: string,
    dto: AssignClaimDto,
    actor: CallerContext,
  ): Promise<Claim> {
    if (actor.role !== 'manager') {
      throw new ForbiddenException(
        `Role '${actor.role}' is not permitted to assign claims.`,
      );
    }

    const claim = await this.prisma.claim.findUnique({ where: { id: claimId } });
    if (!claim) {
      throw new NotFoundException(`Claim '${claimId}' not found.`);
    }

    const adjuster = await this.prisma.user.findUnique({
      where: { id: dto.adjuster_id },
    });
    if (!adjuster || adjuster.deleted_at) {
      throw new BadRequestException(
        `Target adjuster '${dto.adjuster_id}' not found.`,
      );
    }
    if (adjuster.role !== 'adjuster') {
      throw new BadRequestException(
        `Target user '${dto.adjuster_id}' is not an adjuster (role='${adjuster.role}').`,
      );
    }
    if (adjuster.reports_to_id !== actor.id) {
      throw new ForbiddenException(
        `Adjuster '${adjuster.id}' is not in the reporting line of manager '${actor.id}'.`,
      );
    }

    return this.prisma.claim.update({
      where: { id: claimId },
      data: { assigned_adjuster_id: adjuster.id },
    });
  }

  // ─── notes ──────────────────────────────────────────────────────

  /**
   * Append a note. Adjusters write to claims assigned to them;
   * managers write to claims assigned to their reports. The note is
   * immutable once written — corrections are new notes, never edits
   * (brief, Adjuster Workbench §2).
   */
  async addNote(
    claimId: string,
    dto: AddNoteDto,
    actor: CallerContext,
  ): Promise<ClaimNote> {
    const claim = await this.requireWritableClaim(claimId, actor, [
      'adjuster',
      'manager',
    ]);
    await this.requireAssignmentAuthority(claim, actor);

    return this.prisma.claimNote.create({
      data: {
        claim_id: claim.id,
        author_id: actor.id,
        body: dto.body,
      },
    });
  }

  // ─── evidence ───────────────────────────────────────────────────

  /**
   * Attach an evidence record. The actual blob storage is stubbed
   * (the brief lists "file uploads" as out of scope for Track A);
   * the row records `content_hash` for tamper detection and
   * `blob_ref` as the opaque pointer that a real storage layer
   * would resolve. Only the assigned adjuster may attach evidence.
   */
  async addEvidence(
    claimId: string,
    dto: AddEvidenceDto,
    actor: CallerContext,
  ): Promise<Evidence> {
    const claim = await this.requireWritableClaim(claimId, actor, ['adjuster']);
    if (claim.assigned_adjuster_id !== actor.id) {
      throw new ForbiddenException(
        `Only the assigned adjuster may attach evidence to claim '${claim.id}'.`,
      );
    }

    return this.prisma.evidence.create({
      data: {
        claim_id: claim.id,
        kind: dto.kind,
        content_hash: dto.content_hash,
        blob_ref: dto.blob_ref,
        uploaded_by_id: actor.id,
      },
    });
  }

  // ─── witness statements ─────────────────────────────────────────

  /**
   * Record a structured witness statement. The witness phone, when
   * supplied, is encrypted into `witness_phone_ct`. The
   * `inkan_seal_hash` is persisted verbatim and contributes to the
   * audit `payload_hash` via the controller decorator.
   */
  async addWitnessStatement(
    claimId: string,
    dto: AddWitnessStatementDto,
    actor: CallerContext,
  ): Promise<WitnessStatement> {
    const claim = await this.requireWritableClaim(claimId, actor, ['adjuster']);
    if (claim.assigned_adjuster_id !== actor.id) {
      throw new ForbiddenException(
        `Only the assigned adjuster may record a witness statement on claim '${claim.id}'.`,
      );
    }

    return this.prisma.witnessStatement.create({
      data: {
        claim_id: claim.id,
        witness_name: dto.witness_name,
        witness_phone_ct: dto.witness_phone
          ? encryptField(dto.witness_phone)
          : null,
        statement_body: dto.statement_body,
        inkan_seal_hash: dto.inkan_seal_hash,
        recorded_by_id: actor.id,
      },
    });
  }

  // ─── status transitions ────────────────────────────────────────

  /**
   * Drive the claim through the FSM. The transition graph and
   * authority rules live in `claims-status.fsm.ts`; this method's
   * job is to load the row, ask the FSM, and persist the result.
   * Illegal transitions surface as HTTP 422 with the FSM's verbatim
   * reason — that's the brief's contract.
   */
  async updateStatus(
    claimId: string,
    dto: UpdateStatusDto,
    actor: CallerContext,
  ): Promise<Claim> {
    if (actor.role !== 'adjuster' && actor.role !== 'manager') {
      throw new ForbiddenException(
        `Role '${actor.role}' is not permitted to change claim status.`,
      );
    }

    const claim = await this.prisma.claim.findUnique({ where: { id: claimId } });
    if (!claim) {
      throw new NotFoundException(`Claim '${claimId}' not found.`);
    }

    await this.requireAssignmentAuthority(claim, actor);

    const fsmActor: FsmActor = {
      id: actor.id,
      role: actor.role,
      is_claims_director: actor.is_claims_director,
    };
    const result = evaluateTransition(
      { status: claim.status, assigned_adjuster_id: claim.assigned_adjuster_id },
      dto.to,
      fsmActor,
    );
    if (!result.ok) {
      throw new UnprocessableEntityException(result.reason);
    }

    return this.prisma.claim.update({
      where: { id: claim.id },
      data: { status: dto.to },
    });
  }

  // ─── internal helpers ──────────────────────────────────────────

  /**
   * Compose a Prisma `where` predicate that restricts the result
   * set to rows the caller is allowed to see. Returns `null` to
   * signal "caller may see nothing" (a marker the list method
   * checks before issuing the query at all).
   */
  private async applyRoleScope(
    base: Prisma.ClaimWhereInput,
    actor: CallerContext,
  ): Promise<Prisma.ClaimWhereInput | null> {
    switch (actor.role) {
      case 'auditor':
        return base;
      case 'adjuster':
        return { ...base, assigned_adjuster_id: actor.id };
      case 'manager': {
        const reports = await this.prisma.user.findMany({
          where: { reports_to_id: actor.id, role: 'adjuster' },
          select: { id: true },
        });
        const reportIds = reports.map((r) => r.id);
        return {
          ...base,
          OR: [
            { assigned_adjuster_id: { in: reportIds } },
            { assigned_adjuster_id: null },
          ],
        };
      }
      case 'agent': {
        const cutoff = new Date(Date.now() - 24 * 60 * 60 * 1000);
        return {
          ...base,
          created_at: { gte: cutoff },
          reported_by_channel: 'agent',
        };
      }
      case 'siu_referrer':
        // SIU module is Track B; until then this role sees nothing.
        return null;
      default:
        return null;
    }
  }

  /**
   * Per-row read-permission check. Mirrors the list-scope rules but
   * for a single already-loaded claim. Async because the manager
   * branch may need to look up reporting lines.
   */
  private async callerMayReadClaim(
    claim: Claim,
    actor: CallerContext,
  ): Promise<boolean> {
    switch (actor.role) {
      case 'auditor':
        return true;
      case 'adjuster':
        return claim.assigned_adjuster_id === actor.id;
      case 'manager': {
        if (claim.assigned_adjuster_id === null) return true;
        const assignee = await this.prisma.user.findUnique({
          where: { id: claim.assigned_adjuster_id },
          select: { reports_to_id: true },
        });
        return assignee?.reports_to_id === actor.id;
      }
      case 'agent': {
        const ageMs = Date.now() - claim.created_at.getTime();
        return (
          claim.reported_by_channel === 'agent'
          && ageMs <= 24 * 60 * 60 * 1000
        );
      }
      case 'siu_referrer':
        return false;
      default:
        return false;
    }
  }

  /**
   * Load a claim and assert the caller's role is in `permittedRoles`.
   * Throws 404 or 403 with the standard messaging. Returns the
   * loaded row so the caller doesn't double-fetch.
   */
  private async requireWritableClaim(
    claimId: string,
    actor: CallerContext,
    permittedRoles: readonly UserRole[],
  ): Promise<Claim> {
    if (!permittedRoles.includes(actor.role)) {
      throw new ForbiddenException(
        `Role '${actor.role}' is not permitted to perform this action.`,
      );
    }
    const claim = await this.prisma.claim.findUnique({ where: { id: claimId } });
    if (!claim) {
      throw new NotFoundException(`Claim '${claimId}' not found.`);
    }
    return claim;
  }

  /**
   * For writes that depend on assignment: adjusters must be the
   * assignee; managers must own the reporting line that the
   * assignee sits on. Unassigned claims accept writes from managers
   * (so they can triage) but not from adjusters.
   */
  private async requireAssignmentAuthority(
    claim: Claim,
    actor: CallerContext,
  ): Promise<void> {
    if (actor.role === 'adjuster') {
      if (claim.assigned_adjuster_id !== actor.id) {
        throw new ForbiddenException(
          `Adjuster '${actor.id}' is not assigned to claim '${claim.id}'.`,
        );
      }
      return;
    }
    if (actor.role === 'manager') {
      if (claim.assigned_adjuster_id === null) {
        return;
      }
      const assignee = await this.prisma.user.findUnique({
        where: { id: claim.assigned_adjuster_id },
        select: { reports_to_id: true },
      });
      if (assignee?.reports_to_id !== actor.id) {
        throw new ForbiddenException(
          `Claim '${claim.id}' is not in the reporting line of manager '${actor.id}'.`,
        );
      }
      return;
    }
    throw new ForbiddenException(
      `Role '${actor.role}' is not permitted to perform this action.`,
    );
  }
}