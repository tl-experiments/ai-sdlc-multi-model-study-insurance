/**
 * ClaimStatusPill — colour-coded label for a claim's workflow state.
 *
 * Why this component exists
 * -------------------------
 * The claim status is the single most-scanned field in the Workbench. It
 * appears in the queue (`ClaimQueue.tsx`) as a row tag, in the detail
 * header (`ClaimDetail.tsx`) as the headline state, in the reserve
 * approvals view as context for the reserve, and in the audit log as a
 * before/after pair on `claim.status.changed` events.
 *
 * Reviewers expect that label to be:
 *
 *   - **Consistent** across every page — one colour and one phrasing per
 *     `ClaimStatus` value. The status FSM (`claims-status.fsm.ts`) is the
 *     server-side source of truth for transitions; this component is the
 *     client-side source of truth for how each state is rendered.
 *   - **Accessible** — colour never carries the meaning alone; the label
 *     is always present as text and the pill carries an `aria-label`.
 *   - **Domain-faithful** — labels mirror `brief.md`'s state names but
 *     prettified for human reading ("Under Investigation", not
 *     `under_investigation`).
 *
 * The component is purely presentational. It accepts a `ClaimStatus`
 * (the same discriminant the API layer exports) plus optional layout
 * flags, and emits a `<span>` styled with Tailwind utility classes. No
 * hooks, no context — trivially reusable inside tables, timelines, and
 * detail headers.
 */

import type { ClaimStatus } from '../lib/api';

// ─────────────────────────── status descriptor ──────────────────────────

/**
 * Internal lookup mapping each `ClaimStatus` to its display label and
 * Tailwind colour classes. Centralised so a palette change is one edit;
 * the `Record<ClaimStatus, …>` type catches a missing entry at compile
 * time when the enum is extended (Track B will add e.g. `subrogating`).
 *
 * Colour rationale (kept compatible with `RoleBadge.tsx`'s palette so
 * the two never visually collide on the same row):
 *   - `intake`                    — slate:   neutral, just-arrived.
 *   - `under_investigation`       — sky:     active adjuster work.
 *   - `awaiting_reserve_approval` — amber:   waiting on a manager.
 *   - `settlement_offered`        — violet:  ready for customer response.
 *   - `closed_paid`               — emerald: terminal-positive.
 *   - `closed_denied`             — slate (darker): terminal-negative but
 *                                    not alarming — denials are normal.
 *   - `reopened`                  — rose:    needs attention; stands out
 *                                    in any queue scan.
 */
interface StatusDescriptor {
  readonly label: string;
  readonly classes: string;
}

const STATUS_DESCRIPTORS: Record<ClaimStatus, StatusDescriptor> = {
  intake: {
    label: 'Intake',
    classes: 'bg-slate-100 text-slate-700 ring-slate-200',
  },
  under_investigation: {
    label: 'Under Investigation',
    classes: 'bg-sky-100 text-sky-800 ring-sky-200',
  },
  awaiting_reserve_approval: {
    label: 'Awaiting Reserve Approval',
    classes: 'bg-amber-100 text-amber-800 ring-amber-200',
  },
  settlement_offered: {
    label: 'Settlement Offered',
    classes: 'bg-violet-100 text-violet-800 ring-violet-200',
  },
  closed_paid: {
    label: 'Closed — Paid',
    classes: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
  },
  closed_denied: {
    label: 'Closed — Denied',
    classes: 'bg-slate-200 text-slate-800 ring-slate-300',
  },
  reopened: {
    label: 'Reopened',
    classes: 'bg-rose-100 text-rose-800 ring-rose-200',
  },
};

/**
 * Fallback descriptor for unrecognised status strings. The narrow
 * `ClaimStatus` type means this is unreachable through normal typed
 * code paths, but a server enum drift should not crash the page — it
 * renders the raw string in a neutral pill so support staff can see
 * what the backend sent.
 */
const UNKNOWN_STATUS_DESCRIPTOR: StatusDescriptor = {
  label: 'Unknown',
  classes: 'bg-slate-100 text-slate-500 ring-slate-200',
};

function resolveDescriptor(status: ClaimStatus | string): StatusDescriptor {
  const known = (STATUS_DESCRIPTORS as Record<string, StatusDescriptor | undefined>)[status];
  if (known) {
    return known;
  }
  return { ...UNKNOWN_STATUS_DESCRIPTOR, label: status || UNKNOWN_STATUS_DESCRIPTOR.label };
}

// ─────────────────────────── component props ───────────────────────────

export interface ClaimStatusPillProps {
  /**
   * The status to display. Accepts `ClaimStatus` directly (the common
   * case) or a raw string for resilience against backend enum drift —
   * see `resolveDescriptor` above.
   */
  status: ClaimStatus | string;
  /**
   * Optional prefix shown in front of the label, e.g. `"Status"` or
   * `"From"` / `"To"` (used by the audit-log timeline when rendering a
   * `claim.status.changed` event as a before/after pair). Rendered
   * inside the same pill in a muted tone so it does not compete with
   * the status label.
   */
  prefix?: string;
  /**
   * Visual size. `'sm'` is the default and matches inline use in
   * tables and timelines. `'md'` is used in the claim-detail header
   * where the pill stands on its own.
   */
  size?: 'sm' | 'md';
  /**
   * Additional Tailwind classes appended to the root span. Lets callers
   * tweak spacing without forking the component.
   */
  className?: string;
  /**
   * Optional override for the `aria-label`. Defaults to
   * `"Claim status: <label>"`, which is the right answer for nearly
   * every use.
   */
  ariaLabel?: string;
}

// ───────────────────────────── component ───────────────────────────────

const SIZE_CLASSES: Record<NonNullable<ClaimStatusPillProps['size']>, string> = {
  sm: 'px-2 py-0.5 text-xs',
  md: 'px-2.5 py-1 text-sm',
};

/**
 * Render a claim status pill.
 *
 * @example
 *   <ClaimStatusPill status="under_investigation" />
 *   <ClaimStatusPill status={claim.status} size="md" />
 *   <ClaimStatusPill status={event.from_status} prefix="From" />
 */
export function ClaimStatusPill({
  status,
  prefix,
  size = 'sm',
  className,
  ariaLabel,
}: ClaimStatusPillProps): JSX.Element {
  const descriptor = resolveDescriptor(status);
  const sizeClasses = SIZE_CLASSES[size];

  const computedAriaLabel = ariaLabel ?? `Claim status: ${descriptor.label}`;

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
    </span>
  );
}

export default ClaimStatusPill;