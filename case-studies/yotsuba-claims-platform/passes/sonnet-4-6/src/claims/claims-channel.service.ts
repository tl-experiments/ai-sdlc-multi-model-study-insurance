// =============================================================================
// Yotsuba Insurance Holdings — Claims Processing Platform
// src/claims/claims-channel.service.ts
//
// Channel-specific intake normalisation service.
//
// Design reference: design.md §2 API contract, §3 Module structure
// Brief reference:  brief.md §1 FNOL — channel-specific intake stubs
//
// Four intake channels are supported:
//   1. agent      — call-centre agent entering claim on behalf of insured
//   2. mobile     — customer self-service via mobile app
//   3. broker     — broker/dealer portal submission
//   4. email      — parsed inbound email; idempotent on Message-Id
//
// Each channel normalises its raw payload into the canonical CreateClaimDto
// shape expected by ClaimsService.create(). Channel-specific validation rules
// are applied here before hand-off:
//
//   - agent channel:   APPI consent is optional (agent captures verbally);
//                      reporter_relation_to_insured defaults to '代理店'.
//   - mobile channel:  APPI consent MUST be present (digital consent captured
//                      in app); reporter is typically the insured (本人).
//   - broker channel:  APPI consent MUST be present; reporter_relation_to_insured
//                      typically '代理店'; broker_code captured for audit.
//   - email channel:   APPI consent MUST be present; idempotent on message_id
//                      (duplicate message_id returns the existing claim without
//                      creating a new record).
//
// APPI consent:
//   Non-agent channels MUST provide appi_consent_version and appi_consent_at.
//   Agent channel is exempt because consent is captured verbally and recorded
//   separately in the call-centre system; the service layer stamps a system
//   sentinel version in that case.
//
// This service does NOT perform the severity classification or database write —
// it returns a normalised CreateClaimDto that ClaimsService.create() consumes.
// ClaimsService.create() is the single writer to the database.
//
// The idempotency check for email channel DOES query the database (to look up
// an existing claim by external_message_id correlation). This is the only
// database interaction in this service.
// =============================================================================

import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
} from '@nestjs/common';
import { IntakeChannel } from '@prisma/client';
import { PrismaService } from '../prisma.service';
import { CreateClaimDto } from './dto/create-claim.dto';

// ---------------------------------------------------------------------------
// Channel-specific raw payload types
// ---------------------------------------------------------------------------

/**
 * Raw payload received from the agent (call-centre) channel.
 *
 * The agent enters all fields manually via the workbench UI. APPI consent
 * may be omitted — the agent captures it verbally; the service stamps the
 * system sentinel version 'VERBAL_AGENT_V1'.
 */
export interface AgentChannelPayload {
  /** Policy number as read from the policy document or screen. */
  policy_number: string;
  /** Date of loss as entered by the agent (ISO-8601 string or Date). */
  loss_date: string | Date;
  /** Prefecture (都道府県) of the loss location. */
  loss_location_prefecture: string;
  /** Postal code of the loss location (Japanese 7-digit format: NNN-NNNN). */
  loss_location_postal_code: string;
  /** Detailed address below prefecture level. */
  loss_location_detail: string;
  /** Name of the person reporting the claim. */
  reporter_name: string;
  /** Phone number of the reporter (cleartext; service will encrypt). */
  reporter_phone?: string;
  /** Email address of the reporter (cleartext; service will encrypt). */
  reporter_email?: string;
  /**
   * Reporter's relation to the insured.
   * e.g. 本人 / 家族 / 代理店 / 事故相手方
   * Defaults to '代理店' if omitted for agent channel.
   */
  reporter_relation_to_insured?: string;
  /** Incident type selected by the agent. */
  incident_type: CreateClaimDto['incident_type'];
  /** Free-text description in Japanese (UTF-8). */
  initial_description: string;
  /** Whether physical injury has been reported. */
  injury_reported?: boolean;
  /** Whether a third party is involved. */
  third_party_involved?: boolean;
  /** Police report number, if one has been filed. */
  police_report_number?: string;
  /**
   * Optional: declared monetary loss amount (yen) for severity classification.
   * Not persisted directly; used only for severity classification.
   */
  declared_loss_amount_yen?: number;
  /**
   * APPI consent version string (e.g. 'APPI-2023-V2').
   * Optional for agent channel — system sentinel applied if absent.
   */
  appi_consent_version?: string;
  /**
   * Timestamp of APPI consent capture.
   * Optional for agent channel — system sentinel (now) applied if absent.
   */
  appi_consent_at?: string | Date;
}

/**
 * Raw payload received from the mobile app channel.
 *
 * The customer self-service app collects structured data and embeds the
 * APPI consent acknowledgement in-app. Consent fields are mandatory.
 */
export interface MobileChannelPayload extends AgentChannelPayload {
  /** APPI consent version — REQUIRED for mobile channel. */
  appi_consent_version: string;
  /** APPI consent timestamp — REQUIRED for mobile channel. */
  appi_consent_at: string | Date;
  /**
   * Optional device fingerprint for fraud-signal correlation (Track B).
   * Stored in correlation metadata; not persisted in the Claim record.
   */
  device_fingerprint?: string;
}

/**
 * Raw payload received from the broker/dealer portal channel.
 *
 * Brokers submit on behalf of their clients. Consent fields are mandatory.
 */
export interface BrokerChannelPayload extends AgentChannelPayload {
  /** APPI consent version — REQUIRED for broker channel. */
  appi_consent_version: string;
  /** APPI consent timestamp — REQUIRED for broker channel. */
  appi_consent_at: string | Date;
  /**
   * Broker registration code from the carrier's broker registry.
   * Captured for audit purposes; not persisted in the Claim record directly
   * but included in the AuditEvent payload.
   */
  broker_code?: string;
  /**
   * Broker firm name for display purposes.
   */
  broker_firm_name?: string;
}

/**
 * Raw payload received from the email-parse channel.
 *
 * Inbound emails are parsed by an upstream email-ingestion service and
 * submitted here as structured JSON. The channel is idempotent on
 * `message_id` — duplicate submissions return the existing claim record
 * without creating a new one.
 */
export interface EmailChannelPayload extends AgentChannelPayload {
  /** APPI consent version — REQUIRED for email channel. */
  appi_consent_version: string;
  /** APPI consent timestamp — REQUIRED for email channel. */
  appi_consent_at: string | Date;
  /**
   * RFC 5322 Message-Id header value from the inbound email.
   * Used as the idempotency key — if a claim already exists with this
   * message_id, the existing claim is returned without creating a duplicate.
   *
   * Maximum 512 characters to accommodate non-standard Message-Id values.
   */
  message_id: string;
  /**
   * Sender email address as extracted from the From: header.
   * Used to pre-populate reporter_email if not separately provided.
   */
  from_address?: string;
  /**
   * Subject line of the inbound email for context / logging.
   */
  subject?: string;
}

// ---------------------------------------------------------------------------
// Normalisation result types
// ---------------------------------------------------------------------------

/**
 * Result returned by each normalise* method.
 *
 * On idempotent duplicate detection (email channel only), `is_duplicate` is
 * true and `existing_claim_id` holds the ID of the previously-created claim.
 * The caller should return the existing claim rather than creating a new one.
 */
export interface NormalisationResult {
  /** The normalised DTO ready for ClaimsService.create(). */
  dto: CreateClaimDto;
  /** True if the submission is a duplicate (email channel idempotency). */
  is_duplicate: boolean;
  /** Set when is_duplicate is true; the ID of the pre-existing claim. */
  existing_claim_id?: string;
  /**
   * Channel-specific metadata for audit correlation.
   * Included in the AuditEvent payload by the controller.
   */
  channel_metadata: Record<string, string | boolean | undefined>;
}

// ---------------------------------------------------------------------------
// Sentinel values
// ---------------------------------------------------------------------------

/**
 * APPI consent version sentinel applied when agent channel omits consent.
 *
 * Indicates that verbal consent was captured by the call-centre agent and
 * recorded in the telephony/CRM system. The sentinel is a stable string
 * that actuary and compliance teams can filter on in audit exports.
 */
const AGENT_VERBAL_CONSENT_VERSION = 'VERBAL_AGENT_V1';

/**
 * Default reporter relation for agent channel when not explicitly specified.
 * '代理店' = agent/broker acting on behalf of the insured.
 */
const AGENT_DEFAULT_RELATION = '代理店';

/**
 * Default reporter relation for mobile channel when not explicitly specified.
 * '本人' = the insured person themselves.
 */
const MOBILE_DEFAULT_RELATION = '本人';

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

@Injectable()
export class ClaimsChannelService {
  private readonly logger = new Logger(ClaimsChannelService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ─────────────────────────────────────────────────────────────────────────
  // Public normalisation methods
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Normalises a call-centre agent intake payload into a canonical
   * CreateClaimDto.
   *
   * Agent-specific rules:
   *   - APPI consent is optional; sentinel version is stamped if absent.
   *   - reporter_relation_to_insured defaults to '代理店'.
   *   - No idempotency key — each agent submission creates a new claim.
   *
   * @param payload - Raw agent channel payload.
   * @returns Normalisation result with channel=agent.
   */
  normaliseAgentPayload(payload: AgentChannelPayload): NormalisationResult {
    this.logger.debug(
      { policy_number: payload.policy_number, channel: 'agent' },
      'Normalising agent channel payload',
    );

    const consentVersion =
      payload.appi_consent_version ?? AGENT_VERBAL_CONSENT_VERSION;
    const consentAt = payload.appi_consent_at
      ? new Date(payload.appi_consent_at)
      : new Date();

    const dto = this.buildBaseDto({
      ...payload,
      reported_by_channel: IntakeChannel.agent,
      reporter_relation_to_insured:
        payload.reporter_relation_to_insured ?? AGENT_DEFAULT_RELATION,
      appi_consent_version: consentVersion,
      appi_consent_at: consentAt,
    });

    return {
      dto,
      is_duplicate: false,
      channel_metadata: {
        channel: 'agent',
        consent_was_verbal: !payload.appi_consent_version,
      },
    };
  }

  /**
   * Normalises a mobile app intake payload into a canonical CreateClaimDto.
   *
   * Mobile-specific rules:
   *   - APPI consent version and timestamp are REQUIRED (captured in-app).
   *   - reporter_relation_to_insured defaults to '本人'.
   *   - device_fingerprint is captured for audit metadata but not persisted
   *     in the Claim record.
   *
   * @param payload - Raw mobile channel payload.
   * @throws BadRequestException if APPI consent fields are missing.
   * @returns Normalisation result with channel=mobile.
   */
  normaliseMobilePayload(payload: MobileChannelPayload): NormalisationResult {
    this.logger.debug(
      { policy_number: payload.policy_number, channel: 'mobile' },
      'Normalising mobile channel payload',
    );

    this.requireAppiConsent(payload, 'mobile');

    const dto = this.buildBaseDto({
      ...payload,
      reported_by_channel: IntakeChannel.mobile,
      reporter_relation_to_insured:
        payload.reporter_relation_to_insured ?? MOBILE_DEFAULT_RELATION,
      appi_consent_version: payload.appi_consent_version,
      appi_consent_at: new Date(payload.appi_consent_at),
    });

    return {
      dto,
      is_duplicate: false,
      channel_metadata: {
        channel: 'mobile',
        device_fingerprint: payload.device_fingerprint,
      },
    };
  }

  /**
   * Normalises a broker/dealer portal intake payload into a canonical
   * CreateClaimDto.
   *
   * Broker-specific rules:
   *   - APPI consent version and timestamp are REQUIRED.
   *   - reporter_relation_to_insured defaults to '代理店'.
   *   - broker_code and broker_firm_name are captured in channel_metadata
   *     for audit but not persisted in the Claim record.
   *
   * @param payload - Raw broker channel payload.
   * @throws BadRequestException if APPI consent fields are missing.
   * @returns Normalisation result with channel=broker.
   */
  normaliseBrokerPayload(payload: BrokerChannelPayload): NormalisationResult {
    this.logger.debug(
      {
        policy_number: payload.policy_number,
        channel: 'broker',
        broker_code: payload.broker_code,
      },
      'Normalising broker channel payload',
    );

    this.requireAppiConsent(payload, 'broker');

    const dto = this.buildBaseDto({
      ...payload,
      reported_by_channel: IntakeChannel.broker,
      reporter_relation_to_insured:
        payload.reporter_relation_to_insured ?? AGENT_DEFAULT_RELATION,
      appi_consent_version: payload.appi_consent_version,
      appi_consent_at: new Date(payload.appi_consent_at),
    });

    return {
      dto,
      is_duplicate: false,
      channel_metadata: {
        channel: 'broker',
        broker_code: payload.broker_code,
        broker_firm_name: payload.broker_firm_name,
      },
    };
  }

  /**
   * Normalises a parsed email intake payload into a canonical CreateClaimDto.
   *
   * Email-specific rules:
   *   - APPI consent version and timestamp are REQUIRED.
   *   - Idempotent on message_id: if a Claim record already carries a
   *     correlation_id matching the message_id, the existing claim's ID is
   *     returned and is_duplicate is set to true.
   *   - from_address pre-populates reporter_email if not explicitly set.
   *   - reporter_relation_to_insured defaults to '本人' (self-submitted email)
   *     but may be overridden by the parser.
   *
   * NOTE: The idempotency check uses a denormalised lookup via AuditEvent
   * correlation_id, which is set to the message_id by the controller when
   * creating the claim. This avoids adding a dedicated column to the Claim
   * table for Track A; Track B may add an explicit external_message_id index.
   *
   * @param payload - Raw email channel payload.
   * @throws BadRequestException if APPI consent fields are missing.
   * @throws BadRequestException if message_id is absent.
   * @returns Normalisation result with channel=email; may be a duplicate.
   */
  async normaliseEmailPayload(
    payload: EmailChannelPayload,
  ): Promise<NormalisationResult> {
    this.logger.debug(
      {
        policy_number: payload.policy_number,
        channel: 'email',
        message_id: payload.message_id,
      },
      'Normalising email channel payload',
    );

    this.requireAppiConsent(payload, 'email');

    if (!payload.message_id || payload.message_id.trim().length === 0) {
      throw new BadRequestException(
        'Email channel intake requires a non-empty message_id for idempotency.',
      );
    }

    // ── Idempotency check ─────────────────────────────────────────────────
    // Look for an existing AuditEvent where correlation_id = message_id AND
    // action = 'claim.created'. This is the lightweight idempotency pattern
    // for Track A (no dedicated column required on Claim).
    const existingAuditEvent = await this.prisma.auditEvent.findFirst({
      where: {
        correlation_id: payload.message_id,
        action: 'claim.created',
      },
      select: { claim_id: true },
    });

    if (existingAuditEvent?.claim_id) {
      this.logger.warn(
        {
          message_id: payload.message_id,
          existing_claim_id: existingAuditEvent.claim_id,
        },
        'Email channel: duplicate message_id detected — returning existing claim',
      );

      // Return a stub DTO alongside the duplicate signal.
      // The controller will short-circuit and return the existing claim.
      const dto = this.buildBaseDto({
        ...payload,
        reported_by_channel: IntakeChannel.email,
        reporter_relation_to_insured:
          payload.reporter_relation_to_insured ?? MOBILE_DEFAULT_RELATION,
        appi_consent_version: payload.appi_consent_version,
        appi_consent_at: new Date(payload.appi_consent_at),
        reporter_email: payload.from_address ?? payload.reporter_email,
      });

      return {
        dto,
        is_duplicate: true,
        existing_claim_id: existingAuditEvent.claim_id,
        channel_metadata: {
          channel: 'email',
          message_id: payload.message_id,
          subject: payload.subject,
          is_duplicate: true,
        },
      };
    }

    // ── Fresh submission ──────────────────────────────────────────────────
    const dto = this.buildBaseDto({
      ...payload,
      reported_by_channel: IntakeChannel.email,
      reporter_relation_to_insured:
        payload.reporter_relation_to_insured ?? MOBILE_DEFAULT_RELATION,
      appi_consent_version: payload.appi_consent_version,
      appi_consent_at: new Date(payload.appi_consent_at),
      reporter_email: payload.from_address ?? payload.reporter_email,
    });

    return {
      dto,
      is_duplicate: false,
      channel_metadata: {
        channel: 'email',
        message_id: payload.message_id,
        subject: payload.subject,
        from_address: payload.from_address,
      },
    };
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Private helpers
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Builds the canonical CreateClaimDto from a normalised payload.
   *
   * All channel normalisers converge here after applying their channel-specific
   * rules. The result is a DTO that ClaimsService.create() can validate and
   * persist directly.
   *
   * @param normalised - Merged payload with all channel-specific defaults applied.
   * @returns Populated CreateClaimDto.
   */
  private buildBaseDto(
    normalised: AgentChannelPayload & {
      reported_by_channel: IntakeChannel;
      reporter_relation_to_insured: string;
      appi_consent_version: string;
      appi_consent_at: Date;
    },
  ): CreateClaimDto {
    const dto = new CreateClaimDto();

    dto.policy_number = normalised.policy_number.trim();
    dto.loss_date = new Date(normalised.loss_date);
    dto.loss_location_prefecture = normalised.loss_location_prefecture.trim();
    dto.loss_location_postal_code = normalised.loss_location_postal_code.trim();
    dto.loss_location_detail = normalised.loss_location_detail.trim();
    dto.reported_by_channel = normalised.reported_by_channel;
    dto.reporter_name = normalised.reporter_name.trim();
    dto.reporter_phone = normalised.reporter_phone?.trim();
    dto.reporter_email = normalised.reporter_email?.trim().toLowerCase();
    dto.reporter_relation_to_insured = normalised.reporter_relation_to_insured;
    dto.incident_type = normalised.incident_type;
    dto.initial_description = normalised.initial_description.trim();
    dto.injury_reported = normalised.injury_reported ?? false;
    dto.third_party_involved = normalised.third_party_involved ?? false;
    dto.police_report_number = normalised.police_report_number?.trim();
    dto.declared_loss_amount_yen = normalised.declared_loss_amount_yen;
    dto.appi_consent_version = normalised.appi_consent_version;
    dto.appi_consent_at = normalised.appi_consent_at;

    return dto;
  }

  /**
   * Validates that APPI consent fields are present and non-empty.
   *
   * Brief §1 APPI consent capture:
   *   "Reject intake if consent is missing for non-agent channels."
   *
   * @param payload - The payload to validate.
   * @param channel - Channel name for the error message.
   * @throws BadRequestException if either consent field is absent/empty.
   */
  private requireAppiConsent(
    payload: { appi_consent_version?: string; appi_consent_at?: string | Date },
    channel: string,
  ): void {
    if (
      !payload.appi_consent_version ||
      payload.appi_consent_version.trim().length === 0
    ) {
      throw new BadRequestException(
        `APPI consent is required for ${channel} channel intake. ` +
          'Provide appi_consent_version in the request body.',
      );
    }

    if (!payload.appi_consent_at) {
      throw new BadRequestException(
        `APPI consent timestamp is required for ${channel} channel intake. ` +
          'Provide appi_consent_at (ISO-8601) in the request body.',
      );
    }

    const consentDate = new Date(payload.appi_consent_at);
    if (isNaN(consentDate.getTime())) {
      throw new BadRequestException(
        `appi_consent_at must be a valid ISO-8601 datetime string. ` +
          `Received: '${String(payload.appi_consent_at)}'.`,
      );
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Utility: resolve channel from string
  // ─────────────────────────────────────────────────────────────────────────

  /**
   * Resolves a raw channel string to the IntakeChannel enum value.
   *
   * Used by the generic POST /claims endpoint to determine which normaliser
   * to invoke based on the `reported_by_channel` field in the request body.
   *
   * @param raw - Raw string value from the request body.
   * @returns The matching IntakeChannel enum value.
   * @throws BadRequestException if the value is not a recognised channel.
   */
  resolveChannel(raw: string): IntakeChannel {
    const normalised = raw.toLowerCase().trim();
    const valid = Object.values(IntakeChannel) as string[];
    if (!valid.includes(normalised)) {
      throw new BadRequestException(
        `'${raw}' is not a recognised intake channel. ` +
          `Valid values: ${valid.join(', ')}.`,
      );
    }
    return normalised as IntakeChannel;
  }

  /**
   * Dispatches normalisation to the appropriate channel-specific method
   * based on the `reported_by_channel` field already set in the payload.
   *
   * This is a convenience method for the generic POST /claims endpoint so
   * the controller does not need to implement the channel dispatch logic.
   *
   * For the email channel, the caller must use `normaliseEmailPayload`
   * directly (async) — this method will throw if called with channel=email.
   *
   * @param channel - The resolved IntakeChannel.
   * @param payload - The raw channel payload.
   * @returns Synchronous NormalisationResult for agent, mobile, broker channels.
   * @throws ConflictException if called with IntakeChannel.email (use async method).
   */
  normaliseSyncChannel(
    channel: IntakeChannel,
    payload: AgentChannelPayload,
  ): NormalisationResult {
    switch (channel) {
      case IntakeChannel.agent:
        return this.normaliseAgentPayload(payload);

      case IntakeChannel.mobile:
        return this.normaliseMobilePayload(payload as MobileChannelPayload);

      case IntakeChannel.broker:
        return this.normaliseBrokerPayload(payload as BrokerChannelPayload);

      case IntakeChannel.email:
        throw new ConflictException(
          'Email channel normalisation is asynchronous. ' +
            'Use normaliseEmailPayload() directly.',
        );

      default: {
        const _exhaustive: never = channel;
        throw new BadRequestException(
          `Unhandled intake channel: ${String(_exhaustive)}.`,
        );
      }
    }
  }
}