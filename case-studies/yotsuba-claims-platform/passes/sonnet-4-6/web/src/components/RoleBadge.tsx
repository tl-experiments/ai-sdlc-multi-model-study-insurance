/**
 * RoleBadge.tsx
 *
 * Displays a colour-coded badge for a UserRole value.
 *
 * Design constraints:
 *  - Mirrors the five UserRole values from the Prisma schema / API exactly:
 *    agent | adjuster | manager | auditor | siu_referrer
 *  - Optionally shows the claims-director distinction for manager users.
 *  - Tailwind-only styling; no inline styles.
 *  - No `any`; strict TypeScript throughout.
 *  - Accepts an optional `size` prop (sm | md) for use in dense tables vs
 *    full-width detail views.
 */

import React from 'react';
import type { UserRole } from '../lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

export type BadgeSize = 'sm' | 'md';

export interface RoleBadgeProps {
  /** The user role to display. */
  role: UserRole;
  /**
   * When true and role === 'manager', appends a "Director" qualifier to
   * indicate the user also holds the claims-director flag.
   * Default: false.
   */
  isClaimsDirector?: boolean;
  /**
   * Visual size of the badge.
   * - 'sm': compact, suitable for table cells and queue rows.
   * - 'md': standard, suitable for detail headers and sidebars.
   * Default: 'md'.
   */
  size?: BadgeSize;
  /** Additional class names merged onto the root element. */
  className?: string;
}

// ─── Role config ──────────────────────────────────────────────────────────────

interface RoleConfig {
  /** Human-readable label shown in the badge. */
  label: string;
  /**
   * Tailwind colour classes for background, text, and ring.
   * Using ring instead of border to avoid layout shifts.
   */
  colourClasses: string;
}

/**
 * Visual configuration keyed by UserRole.
 *
 * Colour choices follow a consistent logic:
 *  - agent       : blue  — standard intake role
 *  - adjuster    : indigo — core workbench role
 *  - manager     : violet — elevated authority
 *  - auditor     : amber  — read-only oversight (yellow/amber = caution/observe)
 *  - siu_referrer: red    — fraud-related sensitivity
 */
const ROLE_CONFIG: Record<UserRole, RoleConfig> = {
  agent: {
    label: 'Agent',
    colourClasses:
      'bg-blue-50 text-blue-700 ring-blue-600/20',
  },
  adjuster: {
    label: 'Adjuster',
    colourClasses:
      'bg-indigo-50 text-indigo-700 ring-indigo-600/20',
  },
  manager: {
    label: 'Manager',
    colourClasses:
      'bg-violet-50 text-violet-700 ring-violet-600/20',
  },
  auditor: {
    label: 'Auditor',
    colourClasses:
      'bg-amber-50 text-amber-700 ring-amber-600/20',
  },
  siu_referrer: {
    label: 'SIU Referrer',
    colourClasses:
      'bg-red-50 text-red-700 ring-red-600/20',
  },
};

/** Size-specific Tailwind classes. */
const SIZE_CLASSES: Record<BadgeSize, string> = {
  sm: 'px-1.5 py-0.5 text-xs',
  md: 'px-2.5 py-1 text-sm',
};

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * `<RoleBadge>` — renders a pill-shaped badge for a given `UserRole`.
 *
 * @example
 * ```tsx
 * // Standard usage in a table cell
 * <RoleBadge role={user.role} size="sm" />
 *
 * // Claims-director variant
 * <RoleBadge
 *   role="manager"
 *   isClaimsDirector={user.is_claims_director}
 *   size="md"
 * />
 * ```
 */
export function RoleBadge({
  role,
  isClaimsDirector = false,
  size = 'md',
  className = '',
}: RoleBadgeProps): React.ReactElement {
  const config = ROLE_CONFIG[role];

  // Build the display label. For claims-directors we append a qualifier so
  // the badge communicates the additional approval authority at a glance.
  const label =
    role === 'manager' && isClaimsDirector
      ? `${config.label} · Director`
      : config.label;

  const classes = [
    'inline-flex items-center gap-x-1 rounded-full font-medium ring-1 ring-inset whitespace-nowrap',
    config.colourClasses,
    SIZE_CLASSES[size],
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <span className={classes}>
      {/* Role-specific icon dot — colour matches text colour via currentColor */}
      <RoleIcon role={role} />
      {label}
    </span>
  );
}

// ─── Role icon ────────────────────────────────────────────────────────────────

interface RoleIconProps {
  role: UserRole;
}

/**
 * Tiny inline SVG icon that visually differentiates roles beyond colour.
 * Uses `aria-hidden` since the badge text already conveys the meaning.
 */
function RoleIcon({ role }: RoleIconProps): React.ReactElement {
  switch (role) {
    case 'agent':
      // Phone handset — represents call-centre intake
      return (
        <svg
          aria-hidden="true"
          className="h-3 w-3 flex-shrink-0 fill-current"
          viewBox="0 0 20 20"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M2 3a1 1 0 011-1h2.153a1 1 0 01.986.836l.74 4.435a1 1 0 01-.54 1.06l-1.548.773a11.037 11.037 0 006.105 6.105l.774-1.548a1 1 0 011.059-.54l4.435.74a1 1 0 01.836.986V17a1 1 0 01-1 1h-2C7.82 18 2 12.18 2 5V3z" />
        </svg>
      );

    case 'adjuster':
      // Clipboard — represents case-working / investigation
      return (
        <svg
          aria-hidden="true"
          className="h-3 w-3 flex-shrink-0 fill-current"
          viewBox="0 0 20 20"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M9 2a1 1 0 000 2h2a1 1 0 100-2H9z" />
          <path
            fillRule="evenodd"
            d="M4 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5zm3 4a1 1 0 000 2h.01a1 1 0 100-2H7zm3 0a1 1 0 000 2h3a1 1 0 100-2h-3zm-3 4a1 1 0 100 2h.01a1 1 0 100-2H7zm3 0a1 1 0 100 2h3a1 1 0 100-2h-3z"
            clipRule="evenodd"
          />
        </svg>
      );

    case 'manager':
      // Badge / shield — represents authority
      return (
        <svg
          aria-hidden="true"
          className="h-3 w-3 flex-shrink-0 fill-current"
          viewBox="0 0 20 20"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path
            fillRule="evenodd"
            d="M2.166 4.999A11.954 11.954 0 0010 1.944 11.954 11.954 0 0017.834 5c.11.65.166 1.32.166 2.001 0 5.225-3.34 9.67-8 11.317C5.34 16.67 2 12.225 2 7c0-.682.057-1.35.166-2.001zm11.541 3.708a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
            clipRule="evenodd"
          />
        </svg>
      );

    case 'auditor':
      // Eye — represents read-only oversight
      return (
        <svg
          aria-hidden="true"
          className="h-3 w-3 flex-shrink-0 fill-current"
          viewBox="0 0 20 20"
          xmlns="http://www.w3.org/2000/svg"
        >
          <path d="M10 12a2 2 0 100-4 2 2 0 000 4z" />
          <path
            fillRule="evenodd"
            d="M.458 10C1.732 5.943 5.522 3 10 3s8.268 2.943 9.542 7c-1.274 4.057-5.064 7-9.542 7S1.732 14.057.458 10zM14 10a4 4 0 11-8 0 4 4 0 018 0z"
            clipRule="evenodd"
          />
        </svg>
      );

    case 'siu_referrer':
      // Exclamation triangle — represents fraud / SIU alert sensitivity
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
      // TypeScript exhaustiveness check — `role` is `never` here.
      const _exhaustive: never = role;
      void _exhaustive;
      return <span aria-hidden="true" className="h-3 w-3 flex-shrink-0" />;
    }
  }
}

// ─── Convenience: list of all roles (used by filter chips, seed forms) ────────

/**
 * Ordered list of all valid UserRole values.
 * Useful for rendering role filter chips or select options.
 */
export const ALL_ROLES: UserRole[] = [
  'agent',
  'adjuster',
  'manager',
  'auditor',
  'siu_referrer',
];

/**
 * Return the human-readable label for a role without rendering a full badge.
 * Useful in `aria-label` strings and table header tooltips.
 */
export function getRoleLabel(role: UserRole, isClaimsDirector = false): string {
  const config = ROLE_CONFIG[role];
  if (role === 'manager' && isClaimsDirector) {
    return `${config.label} · Director`;
  }
  return config.label;
}