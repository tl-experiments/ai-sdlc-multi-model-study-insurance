/**
 * SeverityPill.tsx
 *
 * Displays a colour-coded pill for a ClaimSeverity value.
 *
 * Design constraints:
 *  - Mirrors the three ClaimSeverity values from the Prisma schema / API exactly:
 *    simple | complex | catastrophic
 *  - Tailwind-only styling; no inline styles.
 *  - No `any`; strict TypeScript throughout.
 *  - Accepts an optional `size` prop (sm | md) for use in dense tables vs
 *    full-width detail views.
 *  - Exports `ALL_SEVERITIES` and `getSeverityLabel` for filter chips and
 *    aria-label strings.
 */

import React from 'react';
import type { ClaimSeverity } from '../lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

export type SeverityPillSize = 'sm' | 'md';

export interface SeverityPillProps {
  /** The claim severity to display. */
  severity: ClaimSeverity;
  /**
   * Visual size of the pill.
   * - 'sm': compact, suitable for table cells and queue rows.
   * - 'md': standard, suitable for detail headers and sidebars.
   * Default: 'md'.
   */
  size?: SeverityPillSize;
  /** Additional class names merged onto the root element. */
  className?: string;
}

// ─── Severity config ──────────────────────────────────────────────────────────

interface SeverityConfig {
  /** Human-readable label shown in the pill. */
  label: string;
  /**
   * Tailwind colour classes for background, text, and ring.
   * Using ring instead of border to avoid layout shifts.
   */
  colourClasses: string;
}

/**
 * Visual configuration keyed by ClaimSeverity.
 *
 * Colour logic follows a traffic-light escalation pattern:
 *  - simple       : green  — routine claim, low urgency
 *  - complex      : amber  — elevated attention required
 *  - catastrophic : red    — immediate escalation, maximum urgency
 */
const SEVERITY_CONFIG: Record<ClaimSeverity, SeverityConfig> = {
  simple: {
    label: 'Simple',
    colourClasses: 'bg-green-50 text-green-700 ring-green-600/20',
  },
  complex: {
    label: 'Complex',
    colourClasses: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  },
  catastrophic: {
    label: 'Catastrophic',
    colourClasses: 'bg-red-50 text-red-700 ring-red-600/20',
  },
};

/** Size-specific Tailwind classes. */
const SIZE_CLASSES: Record<SeverityPillSize, string> = {
  sm: 'px-1.5 py-0.5 text-xs',
  md: 'px-2.5 py-1 text-sm',
};

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * `<SeverityPill>` — renders a pill-shaped badge for a given `ClaimSeverity`.
 *
 * @example
 * ```tsx
 * // Compact usage in a queue row
 * <SeverityPill severity={claim.severity_initial} size="sm" />
 *
 * // Standard usage in a claim detail header
 * <SeverityPill severity={claim.severity_initial} size="md" />
 * ```
 */
export function SeverityPill({
  severity,
  size = 'md',
  className = '',
}: SeverityPillProps): React.ReactElement {
  const config = SEVERITY_CONFIG[severity];

  const classes = [
    'inline-flex items-center gap-x-1.5 rounded-full font-medium ring-1 ring-inset whitespace-nowrap',
    config.colourClasses,
    SIZE_CLASSES[size],
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={classes}>
      {/* Severity-specific indicator icon */}
      <SeverityIcon severity={severity} />
      {config.label}
    </span>
  );
}

// ─── Severity icon ────────────────────────────────────────────────────────────

interface SeverityIconProps {
  severity: ClaimSeverity;
}

/**
 * Small SVG icon that visually differentiates severity levels beyond colour.
 *
 * - simple       : single small dot — minimal visual weight
 * - complex      : exclamation mark — attention required
 * - catastrophic : filled warning triangle — maximum urgency
 *
 * Uses `aria-hidden` since the surrounding text already conveys the severity.
 */
function SeverityIcon({ severity }: SeverityIconProps): React.ReactElement {
  switch (severity) {
    case 'simple':
      // Small filled circle — minimal urgency indicator
      return (
        <svg
          aria-hidden="true"
          className="h-1.5 w-1.5 flex-shrink-0 fill-current"
          viewBox="0 0 6 6"
          xmlns="http://www.w3.org/2000/svg"
        >
          <circle cx="3" cy="3" r="3" />
        </svg>
      );

    case 'complex':
      // Exclamation circle — elevated attention required
      return (
        <svg
          aria-hidden="true"
          className="h-3 w-3 flex-shrink-0 fill-current"
          viewBox="0 0 20 20"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            fillRule="evenodd"
            d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7-4a1 1 0 11-2 0 1 1 0 012 0zM9 9a1 1 0 000 2v3a1 1 0 001 1h1a1 1 0 100-2v-3a1 1 0 00-1-1H9z"
            clipRule="evenodd"
          />
        </svg>
      );

    case 'catastrophic':
      // Warning triangle — maximum urgency / immediate escalation
      return (
        <svg
          aria-hidden="true"
          className="h-3 w-3 flex-shrink-0 fill-current"
          viewBox="0 0 20 20"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            fillRule="evenodd"
            d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
            clipRule="evenodd"
          />
        </svg>
      );

    default: {
      // TypeScript exhaustiveness check — `severity` is `never` here.
      const _exhaustive: never = severity;
      void _exhaustive;
      return <span aria-hidden="true" className="h-1.5 w-1.5 flex-shrink-0" />;
    }
  }
}

// ─── Convenience exports ──────────────────────────────────────────────────────

/**
 * Ordered list of all valid ClaimSeverity values.
 * Ordered from lowest to highest severity.
 * Useful for rendering severity filter chips or select options.
 */
export const ALL_SEVERITIES: ClaimSeverity[] = [
  'simple',
  'complex',
  'catastrophic',
];

/**
 * Return the human-readable label for a severity without rendering a full pill.
 * Useful in `aria-label` strings, table header tooltips, and select option
 * labels.
 *
 * @example
 * ```tsx
 * <option value={severity}>{getSeverityLabel(severity)}</option>
 * ```
 */
export function getSeverityLabel(severity: ClaimSeverity): string {
  return SEVERITY_CONFIG[severity].label;
}

/**
 * Returns true if the given severity requires immediate escalation.
 * Useful for highlighting catastrophic claims in queue views.
 *
 * @example
 * ```tsx
 * const requiresEscalation = isCatastrophic(claim.severity_initial);
 * ```
 */
export function isCatastrophic(severity: ClaimSeverity): boolean {
  return severity === 'catastrophic';
}

/**
 * Returns a numeric weight for sorting purposes (higher = more severe).
 * Useful for sorting claim queues by severity.
 *
 * @example
 * ```tsx
 * claims.sort((a, b) =>
 *   getSeverityWeight(b.severity_initial) - getSeverityWeight(a.severity_initial)
 * );
 * ```
 */
export function getSeverityWeight(severity: ClaimSeverity): number {
  const weights: Record<ClaimSeverity, number> = {
    simple: 1,
    complex: 2,
    catastrophic: 3,
  };
  return weights[severity];
}