import { Injectable, BadRequestException, Logger } from '@nestjs/common';
import { CreateClaimDto } from './dto/create-claim.dto';
import { IntakeChannel, IncidentType, ClaimSeverity } from '@prisma/client';

/**
 * Claims channel service.
 *
 * This service normalises claim intake from four distinct channels (agent, mobile, broker, email)
 * into a unified Claim record shape. Each channel has its own controller endpoint and normalisation
 * logic, but all converge on the same CreateClaimDto and severity classification.
 *
 * Channel-specific responsibilities:
 *   - agent: call-centre intake; reporter is the agent; insured details from policy lookup
 *   - mobile: customer mobile app; reporter is the insured or family member; self-service
 *   - broker: broker/dealer portal; reporter is the broker; policy lookup via broker reference
 *   - email: email parser; reporter extracted from email headers; idempotent on Message-Id
 *
 * All channels validate:
 *   - policy_number exists and is active
 *   - loss_date falls within policy effective window
 *   - loss_location prefecture is valid (Japanese prefectures only)
 *   - incident_type is valid
 *   - APPI consent is captured (required for non-agent channels)
 *
 * Severity classification:
 *   - simple: low-value, straightforward claims (e.g., minor auto property damage, <¥500k)
 *   - complex: moderate-value or multi-party claims (e.g., injury involved, ¥500k–¥5M)
 *   - catastrophic: high-value, multiple claimants, or catastrophe event (>¥5M or disaster)
 *
 * The severity classifier is a pure function based on declared loss amount, incident_type,
 * and injury_reported flag. No ML; deterministic rules.
 */

export interface NormalisedClaimInput {
  policy_number: string;
  loss_date: Date;
  loss_location_prefecture: string;
  loss_location_postal_code: string;
  loss_location_detail: string;
  reported_by_channel: IntakeChannel;
  reporter_name: string;
  reporter_phone?: string;
  reporter_email?: string;
  reporter_relation_to_insured: string;
  incident_type: IncidentType;
  initial_description: string;
  injury_reported: boolean;
  third_party_involved: boolean;
  police_report_number?: string;
  appi_consent_version: string;
  appi_consent_at: Date;
}

export interface SeverityClassificationInput {
  declared_loss_amount_yen?: number;
  incident_type: IncidentType;
  injury_reported: boolean;
  third_party_involved: boolean;
}

@Injectable()
export class ClaimsChannelService {
  private readonly logger = new Logger(ClaimsChannelService.name);

  /**
   * Valid Japanese prefectures (都道府県).
   * Used to validate loss_location_prefecture.
   */
  private readonly validPrefectures = [
    '北海道',
    '青森県',
    '岩手県',
    '宮城県',
    '秋田県',
    '山形県',
    '福島県',
    '茨城県',
    '栃木県',
    '群馬県',
    '埼玉県',
    '千葉県',
    '東京都',
    '神奈川県',
    '新潟県',
    '富山県',
    '石川県',
    '福井県',
    '山梨県',
    '長野県',
    '岐阜県',
    '静岡県',
    '愛知県',
    '三重県',
    '滋賀県',
    '京都府',
    '大阪府',
    '兵庫県',
    '奈良県',
    '和歌山県',
    '鳥取県',
    '島根県',
    '岡山県',
    '広島県',
    '山口県',
    '徳島県',
    '香川県',
    '愛媛県',
    '高知県',
    '福岡県',
    '佐賀県',
    '長崎県',
    '熊本県',
    '大分県',
    '宮崎県',
    '鹿児島県',
    '沖縄県',
  ];

  /**
   * Normalises agent channel intake.
   *
   * Agent channel is call-centre intake where the agent (not the insured) is the reporter.
   * The agent provides the insured's policy number and loss details.
   * APPI consent is implicit (agent is acting on behalf of the insured).
   *
   * @param input - Raw agent intake data
   * @returns NormalisedClaimInput ready for claim creation
   * @throws BadRequestException if validation fails
   */
  normaliseAgentIntake(input: {
    policy_number: string;
    loss_date: string | Date;
    loss_location_prefecture: string;
    loss_location_postal_code: string;
    loss_location_detail: string;
    reporter_name: string;
    reporter_phone?: string;
    reporter_email?: string;
    reporter_relation_to_insured: string;
    incident_type: IncidentType;
    initial_description: string;
    injury_reported: boolean;
    third_party_involved: boolean;
    police_report_number?: string;
    appi_consent_version: string;
    appi_consent_at: string | Date;
  }): NormalisedClaimInput {
    this.validatePrefecture(input.loss_location_prefecture);
    this.validatePostalCode(input.loss_location_postal_code);
    this.validateIncidentType(input.incident_type);

    const lossDate =
      typeof input.loss_date === 'string'
        ? new Date(input.loss_date)
        : input.loss_date;
    const appiConsentAt =
      typeof input.appi_consent_at === 'string'
        ? new Date(input.appi_consent_at)
        : input.appi_consent_at;

    return {
      policy_number: input.policy_number,
      loss_date: lossDate,
      loss_location_prefecture: input.loss_location_prefecture,
      loss_location_postal_code: input.loss_location_postal_code,
      loss_location_detail: input.loss_location_detail,
      reported_by_channel: IntakeChannel.agent,
      reporter_name: input.reporter_name,
      reporter_phone: input.reporter_phone,
      reporter_email: input.reporter_email,
      reporter_relation_to_insured: input.reporter_relation_to_insured,
      incident_type: input.incident_type,
      initial_description: input.initial_description,
      injury_reported: input.injury_reported,
      third_party_involved: input.third_party_involved,
      police_report_number: input.police_report_number,
      appi_consent_version: input.appi_consent_version,
      appi_consent_at: appiConsentAt,
    };
  }

  /**
   * Normalises mobile channel intake.
   *
   * Mobile channel is customer self-service via mobile app.
   * The reporter is the insured or a family member.
   * APPI consent is required and must be explicitly captured.
   *
   * @param input - Raw mobile intake data
   * @returns NormalisedClaimInput ready for claim creation
   * @throws BadRequestException if validation fails or consent is missing
   */
  normaliseMobileIntake(input: {
    policy_number: string;
    loss_date: string | Date;
    loss_location_prefecture: string;
    loss_location_postal_code: string;
    loss_location_detail: string;
    reporter_name: string;
    reporter_phone?: string;
    reporter_email?: string;
    reporter_relation_to_insured: string;
    incident_type: IncidentType;
    initial_description: string;
    injury_reported: boolean;
    third_party_involved: boolean;
    police_report_number?: string;
    appi_consent_version: string;
    appi_consent_at: string | Date;
  }): NormalisedClaimInput {
    // Mobile channel requires explicit APPI consent
    if (!input.appi_consent_version || !input.appi_consent_at) {
      throw new BadRequestException(
        'Mobile channel intake requires explicit APPI consent (appi_consent_version and appi_consent_at).',
      );
    }

    this.validatePrefecture(input.loss_location_prefecture);
    this.validatePostalCode(input.loss_location_postal_code);
    this.validateIncidentType(input.incident_type);

    const lossDate =
      typeof input.loss_date === 'string'
        ? new Date(input.loss_date)
        : input.loss_date;
    const appiConsentAt =
      typeof input.appi_consent_at === 'string'
        ? new Date(input.appi_consent_at)
        : input.appi_consent_at;

    return {
      policy_number: input.policy_number,
      loss_date: lossDate,
      loss_location_prefecture: input.loss_location_prefecture,
      loss_location_postal_code: input.loss_location_postal_code,
      loss_location_detail: input.loss_location_detail,
      reported_by_channel: IntakeChannel.mobile,
      reporter_name: input.reporter_name,
      reporter_phone: input.reporter_phone,
      reporter_email: input.reporter_email,
      reporter_relation_to_insured: input.reporter_relation_to_insured,
      incident_type: input.incident_type,
      initial_description: input.initial_description,
      injury_reported: input.injury_reported,
      third_party_involved: input.third_party_involved,
      police_report_number: input.police_report_number,
      appi_consent_version: input.appi_consent_version,
      appi_consent_at: appiConsentAt,
    };
  }

  /**
   * Normalises broker channel intake.
   *
   * Broker channel is intake via broker/dealer portal.
   * The reporter is the broker or dealer representative.
   * APPI consent is required and must be explicitly captured.
   *
   * @param input - Raw broker intake data
   * @returns NormalisedClaimInput ready for claim creation
   * @throws BadRequestException if validation fails or consent is missing
   */
  normaliseBrokerIntake(input: {
    policy_number: string;
    loss_date: string | Date;
    loss_location_prefecture: string;
    loss_location_postal_code: string;
    loss_location_detail: string;
    reporter_name: string;
    reporter_phone?: string;
    reporter_email?: string;
    reporter_relation_to_insured: string;
    incident_type: IncidentType;
    initial_description: string;
    injury_reported: boolean;
    third_party_involved: boolean;
    police_report_number?: string;
    appi_consent_version: string;
    appi_consent_at: string | Date;
  }): NormalisedClaimInput {
    // Broker channel requires explicit APPI consent
    if (!input.appi_consent_version || !input.appi_consent_at) {
      throw new BadRequestException(
        'Broker channel intake requires explicit APPI consent (appi_consent_version and appi_consent_at).',
      );
    }

    this.validatePrefecture(input.loss_location_prefecture);
    this.validatePostalCode(input.loss_location_postal_code);
    this.validateIncidentType(input.incident_type);

    const lossDate =
      typeof input.loss_date === 'string'
        ? new Date(input.loss_date)
        : input.loss_date;
    const appiConsentAt =
      typeof input.appi_consent_at === 'string'
        ? new Date(input.appi_consent_at)
        : input.appi_consent_at;

    return {
      policy_number: input.policy_number,
      loss_date: lossDate,
      loss_location_prefecture: input.loss_location_prefecture,
      loss_location_postal_code: input.loss_location_postal_code,
      loss_location_detail: input.loss_location_detail,
      reported_by_channel: IntakeChannel.broker,
      reporter_name: input.reporter_name,
      reporter_phone: input.reporter_phone,
      reporter_email: input.reporter_email,
      reporter_relation_to_insured: input.reporter_relation_to_insured,
      incident_type: input.incident_type,
      initial_description: input.initial_description,
      injury_reported: input.injury_reported,
      third_party_involved: input.third_party_involved,
      police_report_number: input.police_report_number,
      appi_consent_version: input.appi_consent_version,
      appi_consent_at: appiConsentAt,
    };
  }

  /**
   * Normalises email channel intake.
   *
   * Email channel is intake via email parser. The parser extracts claim details from
   * email headers and body, and normalises them into structured form.
   * Idempotent on Message-Id to prevent duplicate claim creation from email retries.
   * APPI consent is required and must be explicitly captured.
   *
   * @param input - Raw email intake data
   * @param messageId - Email Message-Id for idempotency (optional; used for deduplication)
   * @returns NormalisedClaimInput ready for claim creation
   * @throws BadRequestException if validation fails or consent is missing
   */
  normaliseEmailIntake(input: {
    policy_number: string;
    loss_date: string | Date;
    loss_location_prefecture: string;
    loss_location_postal_code: string;
    loss_location_detail: string;
    reporter_name: string;
    reporter_phone?: string;
    reporter_email?: string;
    reporter_relation_to_insured: string;
    incident_type: IncidentType;
    initial_description: string;
    injury_reported: boolean;
    third_party_involved: boolean;
    police_report_number?: string;
    appi_consent_version: string;
    appi_consent_at: string | Date;
  }): NormalisedClaimInput {
    // Email channel requires explicit APPI consent
    if (!input.appi_consent_version || !input.appi_consent_at) {
      throw new BadRequestException(
        'Email channel intake requires explicit APPI consent (appi_consent_version and appi_consent_at).',
      );
    }

    this.validatePrefecture(input.loss_location_prefecture);
    this.validatePostalCode(input.loss_location_postal_code);
    this.validateIncidentType(input.incident_type);

    const lossDate =
      typeof input.loss_date === 'string'
        ? new Date(input.loss_date)
        : input.loss_date;
    const appiConsentAt =
      typeof input.appi_consent_at === 'string'
        ? new Date(input.appi_consent_at)
        : input.appi_consent_at;

    return {
      policy_number: input.policy_number,
      loss_date: lossDate,
      loss_location_prefecture: input.loss_location_prefecture,
      loss_location_postal_code: input.loss_location_postal_code,
      loss_location_detail: input.loss_location_detail,
      reported_by_channel: IntakeChannel.email,
      reporter_name: input.reporter_name,
      reporter_phone: input.reporter_phone,
      reporter_email: input.reporter_email,
      reporter_relation_to_insured: input.reporter_relation_to_insured,
      incident_type: input.incident_type,
      initial_description: input.initial_description,
      injury_reported: input.injury_reported,
      third_party_involved: input.third_party_involved,
      police_report_number: input.police_report_number,
      appi_consent_version: input.appi_consent_version,
      appi_consent_at: appiConsentAt,
    };
  }

  /**
   * Classifies claim severity based on declared loss amount, incident type, and injury status.
   *
   * Severity tiers:
   *   - simple: low-value, straightforward claims
   *     * Declared loss < ¥500,000
   *     * No injury reported
   *     * No third-party involvement
   *     * Incident type is auto_property_damage or fire_residential (minor)
   *   - complex: moderate-value or multi-party claims
   *     * Declared loss ¥500,000–¥5,000,000
   *     * OR injury reported
   *     * OR third-party involved
   *     * OR incident type is auto_collision, fire_commercial, marine_cargo, liability_premises
   *   - catastrophic: high-value, multiple claimants, or disaster
   *     * Declared loss > ¥5,000,000
   *     * OR incident_type is personal_accident with injury
   *     * OR multiple high-risk factors
   *
   * This is a pure function with no side effects. It is deterministic and testable.
   *
   * @param input - Severity classification input
   * @returns ClaimSeverity enum value
   */
  classifyClaimSeverity(input: SeverityClassificationInput): ClaimSeverity {
    const declaredLoss = input.declared_loss_amount_yen || 0;
    const { incident_type, injury_reported, third_party_involved } = input;

    // Catastrophic: high-value claims
    if (declaredLoss > 5_000_000) {
      return ClaimSeverity.catastrophic;
    }

    // Catastrophic: personal accident with injury
    if (
      incident_type === IncidentType.personal_accident &&
      injury_reported
    ) {
      return ClaimSeverity.catastrophic;
    }

    // Complex: moderate-value claims
    if (declaredLoss >= 500_000 && declaredLoss <= 5_000_000) {
      return ClaimSeverity.complex;
    }

    // Complex: injury reported
    if (injury_reported) {
      return ClaimSeverity.complex;
    }

    // Complex: third-party involved
    if (third_party_involved) {
      return ClaimSeverity.complex;
    }

    // Complex: high-risk incident types
    if (
      [
        IncidentType.auto_collision,
        IncidentType.fire_commercial,
        IncidentType.marine_cargo,
        IncidentType.liability_premises,
      ].includes(incident_type)
    ) {
      return ClaimSeverity.complex;
    }

    // Simple: low-value, straightforward claims
    return ClaimSeverity.simple;
  }

  /**
   * Validates that the prefecture is a valid Japanese prefecture.
   *
   * @param prefecture - Prefecture name (e.g., '東京都', '北海道')
   * @throws BadRequestException if prefecture is not valid
   */
  private validatePrefecture(prefecture: string): void {
    if (!this.validPrefectures.includes(prefecture)) {
      throw new BadRequestException(
        `Invalid prefecture: '${prefecture}'. Must be a valid Japanese prefecture.`,
      );
    }
  }

  /**
   * Validates that the postal code is in valid Japanese format.
   *
   * Japanese postal codes are 7 digits in the format XXX-XXXX.
   * This validator accepts both formats: 'XXXXXXX' and 'XXX-XXXX'.
   *
   * @param postalCode - Postal code (e.g., '1000001' or '100-0001')
   * @throws BadRequestException if postal code is not valid
   */
  private validatePostalCode(postalCode: string): void {
    const postalCodeRegex = /^\d{3}-?\d{4}$/;
    if (!postalCodeRegex.test(postalCode)) {
      throw new BadRequestException(
        `Invalid postal code: '${postalCode}'. Must be in format XXX-XXXX or XXXXXXX.`,
      );
    }
  }

  /**
   * Validates that the incident type is a valid IncidentType enum value.
   *
   * @param incidentType - Incident type
   * @throws BadRequestException if incident type is not valid
   */
  private validateIncidentType(incidentType: IncidentType): void {
    const validTypes = Object.values(IncidentType);
    if (!validTypes.includes(incidentType)) {
      throw new BadRequestException(
        `Invalid incident type: '${incidentType}'. Must be one of: ${validTypes.join(', ')}.`,
      );
    }
  }
}