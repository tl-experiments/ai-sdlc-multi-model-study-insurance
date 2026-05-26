// ─────────────────────────────────────────────────────────────────────────
// Yotsuba Insurance Holdings · Claims Processing Platform
// Channel-specific FNOL intake normalisers.
//
// The brief specifies four FNOL intake channels — `agent`, `mobile`,
// `broker`, and `email` — and the architectural commitment is that
// all four deposit a `Claim` record with a *unified* shape. The
// per-channel surface differs in two ways:
//
//   1. The payload arrives in slightly different shapes (a mobile
//      app may collapse the postal address into a single string, a
//      broker portal may bundle reporter contact under a `contact`
//      object, an email-parser feed delivers a `Message-Id` for
//      idempotency, etc.).
//
//   2. The trust model differs: agent-channel intakes are taken by a
//      call-centre agent who explicitly captures consent verbally;
//      mobile/broker/email channels are unattended and *must* carry
//      an APPI consent record (see brief: "Reject intake if consent
//      is missing for non-agent channels").
//
// Per design.md §3, this service is responsible only for the
// *normalisation* and *channel-specific validation* steps. The
// resulting normalised payload is then handed to `ClaimsService`,
// which performs the cross-cutting work: policy-window validation,
// severity classification, encryption of special-care PII, audit
// emission. Keeping those concerns in `ClaimsService` (and the
// channel shaping here) means a future fifth channel only needs to
// add a new normaliser, not re-implement intake.
//
// This service is deliberately pure with respect to I/O: no database,
// no HTTP, no logging. That keeps the channel-shaping logic testable
// with plain object literals and easy for a reviewer to read end-to-
// end in one file.
// ─────────────────────────────────────────────────────────────────────────

import { BadRequestException, Injectable } from '@nestjs/common';

import { IntakeChannel } from '@prisma/client';

import { CreateClaimDto } from './dto/create-claim.dto';

/**
 * Channels for which APPI consent must be carried in the intake
 * payload. The `agent` channel is exempt because consent is captured
 * verbally by the call-centre agent at the start of the call and
 * recorded out-of-band; the brief is explicit on this point.
 */
const CONSENT_REQUIRED_CHANNELS: readonly IntakeChannel[] = [
  'mobile',
  'broker',
  'email',
];

/**
 * Loose shape for a mobile-app intake payload. The mobile app
 * typically collapses the postal address into a single free-text
 * field for UX reasons and may omit fields the user has not yet
 * provided; the normaliser fills in defaults and splits the address
 * into the canonical prefecture / postal-code / detail triple.
 */
export interface MobileIntakePayload {
  policy_number: string;
  loss_date: string;
  loss_location_prefecture: string;
  loss_location_postal_code: string;
  loss_location_detail: string;
  reporter_name: string;
  reporter_phone?: string;
  reporter_email?: string;
  reporter_relation_to_insured: string;
  incident_type: CreateClaimDto['incident_type'];
  initial_description: string;
  injury_reported?: boolean;
  third_party_involved?: boolean;
  police_report_number?: string;
  appi_consent_version: string;
  appi_consent_at: string;
  insured_government_id?: string;
  bank_account_for_payout?: string;
  injury_details?: string;
}

/**
 * Loose shape for a broker / dealer portal intake payload. Brokers
 * typically bundle reporter contact under a nested `contact` object
 * and identify themselves via a `broker_id` field that the
 * normaliser surfaces into `reporter_relation_to_insured` when not
 * otherwise specified.
 */
export interface BrokerIntakePayload {
  policy_number: string;
  loss_date: string;
  loss_location: {
    prefecture: string;
    postal_code: string;
    detail: string;
  };
  contact: {
    name: string;
    phone?: string;
    email?: string;
    relation_to_insured?: string;
  };
  broker_id: string;
  incident_type: CreateClaimDto['incident_type'];
  initial_description: string;
  injury_reported?: boolean;
  third_party_involved?: boolean;
  police_report_number?: string;
  appi_consent_version: string;
  appi_consent_at: string;
  insured_government_id?: string;
  bank_account_for_payout?: string;
  injury_details?: string;
}

/**
 * Loose shape for an email-parsed intake payload. The mailbox-parser
 * upstream pre-extracts fields from the inbound email; the
 * `message_id` is the RFC 5322 `Message-Id` header and is used by
 * the controller for idempotent de-duplication (a re-delivered email
 * must not create a second claim).
 */
export interface EmailIntakePayload {
  message_id: string;
  policy_number: string;
  loss_date: string;
  loss_location_prefecture: string;
  loss_location_postal_code: string;
  loss_location_detail: string;
  reporter_name: string;
  reporter_phone?: string;
  reporter_email?: string;
  reporter_relation_to_insured: string;
  incident_type: CreateClaimDto['incident_type'];
  initial_description: string;
  injury_reported?: boolean;
  third_party_involved?: boolean;
  police_report_number?: string;
  appi_consent_version: string;
  appi_consent_at: string;
  insured_government_id?: string;
  bank_account_for_payout?: string;
  injury_details?: string;
}

/**
 * The result of channel normalisation: a `CreateClaimDto`-shaped
 * payload tagged with the originating channel. `ClaimsService`
 * consumes this directly.
 */
export interface NormalisedIntake {
  channel: IntakeChannel;
  dto: CreateClaimDto;
  /**
   * Idempotency key when the channel supplies one (today: the
   * email-parser `Message-Id`). `undefined` for channels that do not
   * provide one; the controller uses it to short-circuit duplicates.
   */
  idempotency_key?: string;
}

/**
 * Channel-specific intake normalisers.
 *
 * Each method takes the raw channel payload, validates the
 * channel-specific shape requirements (presence of APPI consent on
 * unattended channels, presence of an idempotency key on the email
 * channel, etc.), and returns a `NormalisedIntake` that downstream
 * code can treat uniformly.
 *
 * This service does not encrypt PII, classify severity, validate the
 * policy window, or write to the database. Those concerns live in
 * `ClaimsService` so that they are applied identically regardless of
 * which channel the intake came from.
 */
@Injectable()
export class ClaimsChannelService {
  /**
   * Normalise an agent-channel intake. The agent channel accepts the
   * canonical `CreateClaimDto` directly because the call-centre
   * application already conforms to it. APPI consent is captured
   * verbally and may be supplied here for record-keeping, but is
   * not strictly required on this channel.
   */
  normaliseAgent(payload: CreateClaimDto): NormalisedIntake {
    return {
      channel: 'agent',
      dto: this.withChannel(payload, 'agent'),
    };
  }

  /**
   * Normalise a mobile-app intake. The mobile app delivers fields in
   * the canonical names but may omit booleans (which default to
   * `false`) and must carry an APPI consent record because the
   * channel is unattended.
   */
  normaliseMobile(payload: MobileIntakePayload): NormalisedIntake {
    this.requireConsent('mobile', payload.appi_consent_version, payload.appi_consent_at);

    const dto: CreateClaimDto = {
      policy_number: payload.policy_number,
      loss_date: payload.loss_date,
      loss_location_prefecture: payload.loss_location_prefecture,
      loss_location_postal_code: payload.loss_location_postal_code,
      loss_location_detail: payload.loss_location_detail,
      reported_by_channel: 'mobile',
      reporter_name: payload.reporter_name,
      reporter_phone: payload.reporter_phone,
      reporter_email: payload.reporter_email,
      reporter_relation_to_insured: payload.reporter_relation_to_insured,
      incident_type: payload.incident_type,
      initial_description: payload.initial_description,
      injury_reported: payload.injury_reported ?? false,
      third_party_involved: payload.third_party_involved ?? false,
      police_report_number: payload.police_report_number,
      appi_consent_version: payload.appi_consent_version,
      appi_consent_at: payload.appi_consent_at,
      insured_government_id: payload.insured_government_id,
      bank_account_for_payout: payload.bank_account_for_payout,
      injury_details: payload.injury_details,
    };

    return { channel: 'mobile', dto };
  }

  /**
   * Normalise a broker / dealer portal intake. The broker channel
   * bundles location and contact into nested objects; the normaliser
   * flattens these into the canonical shape. When the broker does
   * not specify a `relation_to_insured` we default it to
   * `代理店` (broker / agent) since the broker portal is, by
   * definition, a broker-mediated channel.
   */
  normaliseBroker(payload: BrokerIntakePayload): NormalisedIntake {
    this.requireConsent('broker', payload.appi_consent_version, payload.appi_consent_at);

    const dto: CreateClaimDto = {
      policy_number: payload.policy_number,
      loss_date: payload.loss_date,
      loss_location_prefecture: payload.loss_location.prefecture,
      loss_location_postal_code: payload.loss_location.postal_code,
      loss_location_detail: payload.loss_location.detail,
      reported_by_channel: 'broker',
      reporter_name: payload.contact.name,
      reporter_phone: payload.contact.phone,
      reporter_email: payload.contact.email,
      reporter_relation_to_insured:
        payload.contact.relation_to_insured ?? '代理店',
      incident_type: payload.incident_type,
      initial_description: payload.initial_description,
      injury_reported: payload.injury_reported ?? false,
      third_party_involved: payload.third_party_involved ?? false,
      police_report_number: payload.police_report_number,
      appi_consent_version: payload.appi_consent_version,
      appi_consent_at: payload.appi_consent_at,
      insured_government_id: payload.insured_government_id,
      bank_account_for_payout: payload.bank_account_for_payout,
      injury_details: payload.injury_details,
    };

    return { channel: 'broker', dto };
  }

  /**
   * Normalise an email-parsed intake. The email channel must carry a
   * non-empty `message_id`; the controller uses it for idempotent
   * de-duplication of redelivered messages. APPI consent must also
   * be present — for the email channel this is captured by the
   * mailbox-parser upstream when the reporter clicks a consent link
   * in the acknowledgement reply.
   */
  normaliseEmail(payload: EmailIntakePayload): NormalisedIntake {
    const messageId = (payload.message_id ?? '').trim();
    if (messageId.length === 0) {
      throw new BadRequestException(
        'Email-channel intake requires a non-empty message_id for idempotency.',
      );
    }
    this.requireConsent('email', payload.appi_consent_version, payload.appi_consent_at);

    const dto: CreateClaimDto = {
      policy_number: payload.policy_number,
      loss_date: payload.loss_date,
      loss_location_prefecture: payload.loss_location_prefecture,
      loss_location_postal_code: payload.loss_location_postal_code,
      loss_location_detail: payload.loss_location_detail,
      reported_by_channel: 'email',
      reporter_name: payload.reporter_name,
      reporter_phone: payload.reporter_phone,
      reporter_email: payload.reporter_email,
      reporter_relation_to_insured: payload.reporter_relation_to_insured,
      incident_type: payload.incident_type,
      initial_description: payload.initial_description,
      injury_reported: payload.injury_reported ?? false,
      third_party_involved: payload.third_party_involved ?? false,
      police_report_number: payload.police_report_number,
      appi_consent_version: payload.appi_consent_version,
      appi_consent_at: payload.appi_consent_at,
      insured_government_id: payload.insured_government_id,
      bank_account_for_payout: payload.bank_account_for_payout,
      injury_details: payload.injury_details,
    };

    return { channel: 'email', dto, idempotency_key: messageId };
  }

  // ─── internals ──────────────────────────────────────────────────

  /**
   * Enforce the APPI-consent requirement on non-agent channels.
   * Throws `BadRequestException` (→ HTTP 400) when consent is
   * missing or empty; the controller will surface the message
   * verbatim through the global error filter.
   */
  private requireConsent(
    channel: IntakeChannel,
    version: string | undefined,
    at: string | undefined,
  ): void {
    if (!CONSENT_REQUIRED_CHANNELS.includes(channel)) {
      return;
    }
    const v = (version ?? '').trim();
    const a = (at ?? '').trim();
    if (v.length === 0 || a.length === 0) {
      throw new BadRequestException(
        `APPI consent (appi_consent_version and appi_consent_at) is required `
        + `for intake on the '${channel}' channel.`,
      );
    }
  }

  /**
   * Stamp the canonical `reported_by_channel` onto an incoming
   * `CreateClaimDto`. The agent-channel controller may receive a
   * payload whose `reported_by_channel` is wrong or omitted; the
   * normaliser is the single point of truth for which channel a
   * given intake came from.
   */
  private withChannel(
    dto: CreateClaimDto,
    channel: IntakeChannel,
  ): CreateClaimDto {
    return { ...dto, reported_by_channel: channel };
  }
}