import {
  IsString,
  IsEnum,
  IsBoolean,
  IsOptional,
  IsDateString,
  IsEmail,
  IsPhoneNumber,
  MinLength,
  MaxLength,
  ValidateIf,
} from 'class-validator';
import { IntakeChannel, IncidentType } from '@prisma/client';

/**
 * DTO for creating a new claim via FNOL (First Notice of Loss) intake.
 *
 * This DTO is used across all four intake channels (agent, mobile, broker, email).
 * Channel-specific normalisers in claims-channel.service.ts transform raw channel
 * payloads into this unified shape.
 *
 * Validation rules:
 *   - policy_number: required, non-empty string
 *   - loss_date: required, ISO 8601 date string; must fall within policy effective window
 *   - loss_location_prefecture: required, must be a valid Japanese prefecture code
 *   - loss_location_postal_code: required, Japanese postal code format (NNN-NNNN)
 *   - loss_location_detail: required, free-text address detail
 *   - reported_by_channel: required, one of agent|mobile|broker|email
 *   - reporter_name: required, non-empty string
 *   - reporter_phone: optional, E.164 format if provided
 *   - reporter_email: optional, valid email if provided
 *   - reporter_relation_to_insured: required, e.g. 本人/家族/代理店/事故相手方
 *   - incident_type: required, one of the defined IncidentType enum values
 *   - initial_description: required, free-text description (>= 10 chars)
 *   - injury_reported: optional boolean (default false)
 *   - third_party_involved: optional boolean (default false)
 *   - police_report_number: optional, non-empty string if provided
 *   - appi_consent_version: required, version identifier of APPI consent form
 *   - appi_consent_at: required, ISO 8601 timestamp of consent capture
 *
 * APPI compliance:
 *   - appi_consent_version and appi_consent_at are mandatory for all non-agent channels.
 *   - Agent channel (call centre) may omit consent if verbal consent is recorded separately.
 *   - Mobile, broker, and email channels must include explicit consent capture.
 *
 * Usage:
 *   const dto = new CreateClaimDto();
 *   dto.policy_number = 'POL-2024-001234';
 *   dto.loss_date = '2024-01-15T10:30:00Z';
 *   // ... populate other fields
 *   await claimsService.createClaim(dto, user);
 */
export class CreateClaimDto {
  /**
   * Policy number linked to this claim.
   * Must be validated against the external Policy Service stub.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  policy_number: string;

  /**
   * Date and time of the loss event.
   * ISO 8601 format. Must fall within the policy's effective window.
   * Validation is performed at the service layer after policy lookup.
   */
  @IsDateString()
  loss_date: string;

  /**
   * Japanese prefecture code (都道府県).
   * Must be one of the 47 valid prefecture codes (e.g., '東京都', '大阪府').
   * Validated against a known list in the service layer.
   */
  @IsString()
  @MinLength(2)
  @MaxLength(10)
  loss_location_prefecture: string;

  /**
   * Japanese postal code (郵便番号).
   * Format: NNN-NNNN (e.g., '100-0001').
   * Validated via regex in the service layer.
   */
  @IsString()
  @MinLength(7)
  @MaxLength(8)
  loss_location_postal_code: string;

  /**
   * Detailed address information (市区町村, 番地, etc.).
   * Free-text field; stored as UTF-8.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  loss_location_detail: string;

  /**
   * Channel through which the claim was reported.
   * One of: agent (call centre), mobile (customer app), broker (dealer portal), email (parsed).
   */
  @IsEnum(IntakeChannel)
  reported_by_channel: IntakeChannel;

  /**
   * Name of the person reporting the claim.
   * Stored as standard PII; role-masked in API responses.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  reporter_name: string;

  /**
   * Phone number of the reporter (optional).
   * E.164 format if provided (e.g., '+81-90-1234-5678').
   * Stored as special-care PII (encrypted at rest).
   */
  @IsOptional()
  @IsPhoneNumber('JP')
  reporter_phone?: string;

  /**
   * Email address of the reporter (optional).
   * Valid email format if provided.
   * Stored as standard PII; role-masked in API responses.
   */
  @IsOptional()
  @IsEmail()
  reporter_email?: string;

  /**
   * Relationship of the reporter to the insured.
   * Examples: 本人 (self), 家族 (family), 代理店 (agent), 事故相手方 (third party).
   * Free-text field; validated against a known list in the service layer.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  reporter_relation_to_insured: string;

  /**
   * Type of incident.
   * One of: auto_collision, auto_property_damage, fire_residential, fire_commercial,
   * marine_cargo, liability_premises, personal_accident.
   */
  @IsEnum(IncidentType)
  incident_type: IncidentType;

  /**
   * Initial description of the loss event.
   * Free-text field; stored as UTF-8.
   * Used for initial triage and severity classification.
   */
  @IsString()
  @MinLength(10)
  @MaxLength(2000)
  initial_description: string;

  /**
   * Whether injury was reported in the incident.
   * Optional; defaults to false.
   * Used in severity classification and triage.
   */
  @IsOptional()
  @IsBoolean()
  injury_reported?: boolean;

  /**
   * Whether a third party was involved in the incident.
   * Optional; defaults to false.
   * Used in severity classification and potential subrogation flagging.
   */
  @IsOptional()
  @IsBoolean()
  third_party_involved?: boolean;

  /**
   * Police report number (if applicable).
   * Optional; typically present for auto/liability incidents.
   * Stored as a reference for investigation.
   */
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(50)
  police_report_number?: string;

  /**
   * Version identifier of the APPI consent form presented to the reporter.
   * Required for all channels; mandatory for non-agent channels.
   * Example: 'appi-consent-v1.0-2024-01'.
   */
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  appi_consent_version: string;

  /**
   * ISO 8601 timestamp of APPI consent capture.
   * Required for all channels; mandatory for non-agent channels.
   * Indicates when the reporter acknowledged the APPI consent form.
   */
  @IsDateString()
  appi_consent_at: string;
}