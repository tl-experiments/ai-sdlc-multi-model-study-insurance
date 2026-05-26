/**
 * RoleBadge — compact, colour-coded label for a user's role.
 *
 * Why this component exists
 * -------------------------
 * The Workbench surfaces the current user's role in the layout header, and
 * also tags rows in the audit log and reserve-approval queue with the
 * acting user's role. Reviewers expect those labels to be:
 *
 *   - **Consistent** across every page — the same role always renders
 *     with the same glyph, colour, and copy. A second source-of-truth
 *     would drift the first time we tweak a palette.
 *   - **Accessible** — colour alone never carries the meaning; the role
 *     name is always present as text, and the badge carries an
 *     `aria-label` that spells out "Role: Manager" for screen readers.
 *   - **Domain-faithful** — the labels match `brief.md`'s role matrix
 *     verbatim ("SIU Referrer", not "SIU"; "Auditor", not "Audit").
 *
 * The component is purely presentational. It accepts a `UserRole` (the
 * same discriminant the API layer exports) plus optional layout flags,
 * and emits a `<span>` styled with Tailwind utility classes. No hooks,
 * no context — which keeps it trivially reusable inside tables, headers,
 * and the timeline view of `ClaimDetail.tsx`.
 */

import type { UserRole } from '../lib/api';

// ─────────────────────────── role descriptor ────────────────────────────

/**
 * Internal lookup table mapping each `UserRole` to its display label and
 * Tailwind colour classes. Centralising this here means a palette change
 * is one edit, and the type system catches a missing role entry at
 * compile time (`Record<UserRole, …>`).
 *
 * Colour rationale:
 *   - `agent`        — slate: front-of-house, low operational privilege.
 *   - `adjuster`     — sky:   the day-to-day operator role, neutral-positive.
 *   - `manager`      — indigo: elevated authority, used sparingly in UI.
 *   - `auditor`      — amber: read-only oversight; warm tone signals attention
 *                       without implying error.
 *   - `siu_referrer` — rose:  fraud-adjacent; stands out from the rest of the
 *                       palette so audit-log scans pick it up immediately.
 */
interface RoleDescriptor {
  readonly label: string;
  readonly classes: string;
}

const ROLE_DESCRIPTORS: Record<UserRole, RoleDescriptor> = {
  agent: {
    label: 'Agent',
    classes: 'bg-slate-100 text-slate-700 ring-slate-200',
  },
  adjuster: {
    label: 'Adjuster',
    classes: 'bg-sky-100 text-sky-800 ring-sky-200',
  },
  manager: {
    label: 'Manager',
    classes: 'bg-indigo-100 text-indigo-800 ring-indigo-200',
  },
  auditor: {
    label: 'Auditor',
    classes: 'bg-amber-100 text-amber-800 ring-amber-200',
  },
  siu_referrer: {
    label: 'SIU Referrer',
    classes: 'bg-rose-100 text-rose-800 ring-rose-200',
  },
};

/**
 * Fallback descriptor used when the badge receives an unrecognised role
 * string. This should never happen in practice — the `UserRole` type is
 * narrow — but the runtime guard means a server enum drift cannot crash
 * the page; it merely renders the raw string in a neutral pill.
 */
const UNKNOWN_ROLE_DESCRIPTOR: RoleDescriptor = {
  label: 'Unknown',
  classes: 'bg-slate-100 text-slate-500 ring-slate-200',
};

function resolveDescriptor(role: UserRole | string): RoleDescriptor & { label: string } {
  const known = (ROLE_DESCRIPTORS as Record<string, RoleDescriptor | undefined>)[role];
  if (known) {
    return known;
  }
  // Unknown enum value — surface the raw string so support staff can see
  // what the backend sent, but keep the neutral colour.
  return { ...UNKNOWN_ROLE_DESCRIPTOR, label: role || UNKNOWN_ROLE_DESCRIPTOR.label };
}

// ─────────────────────────── component props ────────────────────────────

export interface RoleBadgeProps {
  /**
   * The role to display. Accepts `UserRole` directly (the common case)
   * or a raw string for resilience against backend drift — see
   * `resolveDescriptor` above.
   */
  role: UserRole | string;
  /**
   * Optional prefix shown in front of the label, e.g. `"Role"` or
   * `"Acting as"`. Rendered inside the same pill in a slightly muted
   * tone so it does not compete with the role itself.
   */
  prefix?: string;
  /**
   * Visual size. `'sm'` is the default and matches the inline use in
   * tables and timelines. `'md'` is used in the layout header where
   * the badge needs to stand on its own.
   */
  size?: 'sm' | 'md';
  /**
   * If `true`, the claims-director flag is rendered as a small `★` glyph
   * after the label. Used in the layout header and reserve-approval
   * queue so reviewers can see at a glance who can director-approve.
   */
  isClaimsDirector?: boolean;
  /**
   * Additional Tailwind classes appended to the root span. Lets callers
   * tweak spacing without forking the component.
   */
  className?: string;
  /**
   * Optional override for the `aria-label`. Defaults to
   * `"Role: <label>"`, which is the right answer for nearly every use.
   */
  ariaLabel?: string;
}

// ───────────────────────────── component ────────────────────────────────

const SIZE_CLASSES: Record<NonNullable<RoleBadgeProps['size']>, string> = {
  sm: 'px-2 py-0.5 text-xs',
  md: 'px-2.5 py-1 text-sm',
};

/**
 * Render a role badge.
 *
 * @example
 *   <RoleBadge role="manager" isClaimsDirector />
 *   <RoleBadge role={user.role} prefix="Signed in as" size="md" />
 */
export function RoleBadge({
  role,
  prefix,
  size = 'sm',
  isClaimsDirector = false,
  className,
  ariaLabel,
}: RoleBadgeProps): JSX.Element {
  const descriptor = resolveDescriptor(role);
  const sizeClasses = SIZE_CLASSES[size];

  const computedAriaLabel =
    ariaLabel ??
    (isClaimsDirector
      ? `Role: ${descriptor.label} (Claims Director)`
      : `Role: ${descriptor.label}`);

  const rootClassName = [
    'inline-flex items-center gap-1 rounded-full font-medium ring-1 ring-inset whitespace-nowrap',
    sizeClasses,
    descriptor.classes,
    className ?? '',
  ]
    .filter((part) => part.length > 0)
    .join(' ');

  return (
    <span className={rootClassName} aria-label={computedAriaLabel}>
      {prefix ? (
        <span className="font-normal opacity-70" aria-hidden="true">
          {prefix}:
        </span>
      ) : null}
      <span>{descriptor.label}</span>
      {isClaimsDirector ? (
        <span
          aria-hidden="true"
          title="Claims Director"
          className="ml-0.5 text-amber-600"
        >
          ★
        </span>
      ) : null}
    </span>
  );
}

export default RoleBadge;