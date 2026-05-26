/**
 * ClaimStatusPill.tsx
 *
 * Displays a colour-coded pill for a ClaimStatus value.
 *
 * Design constraints:
 *  - Mirrors the seven ClaimStatus values from the Prisma schema / API exactly:
 *    intake | under_investigation | awaiting_reserve_approval |
 *    settlement_offered | closed_paid | closed_denied | reopened
 *  - Tailwind-only styling; no inline styles.
 *  - No `any`; strict TypeScript throughout.
 *  - Accepts an optional `size` prop (sm | md) for use in dense tables vs
 *    full-width detail views.
 *  - Exports `ALL_STATUSES` and `getStatusLabel` for filter chips and
 *    aria-label strings.
 */

import React from 'react';
import type { ClaimStatus } from '../lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

export type PillSize = 'sm' | 'md';

export interface ClaimStatusPillProps {
  /** The claim status to display. */
  status: ClaimStatus;
  /**
   * Visual size of the pill.
   * - 'sm': compact, suitable for table cells and queue rows.
   * - 'md': standard, suitable for detail headers and sidebars.
   * Default: 'md'.
   */
  size?: PillSize;
  /** Additional class names merged onto the root element. */
  className?: string;
}

// ─── Status config ────────────────────────────────────────────────────────────

interface StatusConfig {
  /** Human-readable label shown in the pill. */
  label: string;
  /**
   * Tailwind colour classes for background, text, and ring.
   * Using ring instead of border to avoid layout shifts.
   */
  colourClasses: string;
}

/**
 * Visual configuration keyed by ClaimStatus.
 *
 * Colour logic:
 *  - intake                   : gray   — neutral / new / not yet actioned
 *  - under_investigation      : blue   — active work in progress
 *  - awaiting_reserve_approval: yellow — pending approval / blocked
 *  - settlement_offered       : indigo — near resolution, offer made
 *  - closed_paid              : green  — resolved successfully
 *  - closed_denied            : red    — resolved negatively
 *  - reopened                 : orange — requires re-attention
 */
const STATUS_CONFIG: Record<ClaimStatus, StatusConfig> = {
  intake: {
    label: 'Intake',
    colourClasses: 'bg-gray-50 text-gray-600 ring-gray-500/20',
  },
  under_investigation: {
    label: 'Under Investigation',
    colourClasses: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  },
  awaiting_reserve_approval: {
    label: 'Awaiting Reserve Approval',
    colourClasses: 'bg-yellow-50 text-yellow-800 ring-yellow-600/20',
  },
  settlement_offered: {
    label: 'Settlement Offered',
    colourClasses: 'bg-indigo-50 text-indigo-700 ring-indigo-600/20',
  },
  closed_paid: {
    label: 'Closed — Paid',
    colourClasses: 'bg-green-50 text-green-700 ring-green-600/20',
  },
  closed_denied: {
    label: 'Closed — Denied',
    colourClasses: 'bg-red-50 text-red-700 ring-red-600/20',
  },
  reopened: {
    label: 'Reopened',
    colourClasses: 'bg-orange-50 text-orange-700 ring-orange-600/20',
  },
};

/** Size-specific Tailwind classes. */
const SIZE_CLASSES: Record<PillSize, string> = {
  sm: 'px-1.5 py-0.5 text-xs',
  md: 'px-2.5 py-1 text-sm',
};

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * `<ClaimStatusPill>` — renders a pill-shaped badge for a given `ClaimStatus`.
 *
 * @example
 * ```tsx
 * // Compact usage in a queue row
 * <ClaimStatusPill status={claim.status} size="sm" />
 *
 * // Standard usage in a claim detail header
 * <ClaimStatusPill status={claim.status} size="md" />
 * ```
 */
export function ClaimStatusPill({
  status,
  size = 'md',
  className = '',
}: ClaimStatusPillProps): React.ReactElement {
  const config = STATUS_CONFIG[status];

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
      {/* Status-specific indicator dot */}
      <StatusDot status={status} />
      {config.label}
    </span>
  );
}

// ─── Status dot ───────────────────────────────────────────────────────────────

interface StatusDotProps {
  status: ClaimStatus;
}

/**
 * Small SVG circle whose fill colour reinforces the pill's semantic meaning.
 * Uses `fill-current` so it inherits the pill's text colour automatically.
 * `aria-hidden` since the surrounding text already conveys the status.
 */
function StatusDot({ status }: StatusDotProps): React.ReactElement {
  // Terminal / closed states use a filled circle; active states use a pulsing
  // dot to give at-a-glance urgency cues.
  const isTerminal =
    status === 'closed_paid' || status === 'closed_denied';
  const isBlocked = status === 'awaiting_reserve_approval';
  const isReopened = status === 'reopened';

  if (isTerminal) {
    // Solid filled circle — no animation for closed claims.
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
  }

  if (isBlocked || isReopened) {
    // Outlined ring — signals attention required.
    return (
      <svg
        aria-hidden="true"
        className="h-1.5 w-1.5 flex-shrink-0"
        viewBox="0 0 6 6"
        xmlns="http://www.w3.org/2000/svg"
      >
        <circle
          cx="3"
          cy="3"
          r="2"
          className="fill-current"
          stroke="currentColor"
          strokeWidth="1"
        />
      </svg>
    );
  }

  // Active states (intake, under_investigation, settlement_offered) — filled
  // dot to indicate ongoing activity.
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
}

// ─── Convenience exports ──────────────────────────────────────────────────────

/**
 * Ordered list of all valid ClaimStatus values.
 * Useful for rendering status filter chips or select options.
 * Order follows the typical claim lifecycle progression.
 */
export const ALL_STATUSES: ClaimStatus[] = [
  'intake',
  'under_investigation',
  'awaiting_reserve_approval',
  'settlement_offered',
  'closed_paid',
  'closed_denied',
  'reopened',
];

/**
 * Return the human-readable label for a status without rendering a full pill.
 * Useful in `aria-label` strings, table header tooltips, and select option
 * labels.
 *
 * @example
 * ```tsx
 * <option value={status}>{getStatusLabel(status)}</option>
 * ```
 */
export function getStatusLabel(status: ClaimStatus): string {
  return STATUS_CONFIG[status].label;
}

/**
 * Returns true if the given status represents a terminal (closed) state.
 * Useful for disabling action buttons on closed claims.
 *
 * @example
 * ```tsx
 * const canAddNote = !isTerminalStatus(claim.status);
 * ```
 */
export function isTerminalStatus(status: ClaimStatus): boolean {
  return status === 'closed_paid' || status === 'closed_denied';
}

/**
 * Returns true if the claim is in an active (non-terminal, non-intake) state.
 * Useful for highlighting claims that require adjuster attention.
 */
export function isActiveStatus(status: ClaimStatus): boolean {
  return (
    status === 'under_investigation' ||
    status === 'awaiting_reserve_approval' ||
    status === 'settlement_offered' ||
    status === 'reopened'
  );
}