/**
 * SeverityPill — colour-coded label for a claim's initial severity classification.
 *
 * Why this component exists
 * -------------------------
 * Severity is the second-most-scanned field in the Workbench after status.
 * The FNOL intake classifier (`claims.service.ts`) computes
 * `severity_initial` from declared loss amount + incident type + whether
 * injury was reported, and that triage label drives queue prioritisation
 * and adjuster workload distribution. Reviewers want to spot a
 * `catastrophic` claim from across the room.
 *
 * Reviewers expect that label to be:
 *
 *   - **Consistent** across every page — one colour and one phrasing per
 *     `ClaimSeverity` value. The classifier on the server is the source
 *     of truth for *what* severity a claim has; this component is the
 *     source of truth for *how* it is rendered.
 *   - **Accessible** — colour never carries the meaning alone; the label
 *     is always present as text and the pill carries an `aria-label`.
 *   - **Domain-faithful** — labels mirror `brief.md`'s severity names but
 *     prettified for human reading ("Catastrophic", not `catastrophic`).
 *
 * The component is purely presentational, mirroring the shape of
 * `RoleBadge.tsx` and `ClaimStatusPill.tsx` so the three compose cleanly
 * on the same row without visual collisions. No hooks, no context —
 * trivially reusable inside tables, queue rows, and detail headers.
 */

import type { ClaimSeverity } from '../lib/api';

// ─────────────────────────── severity descriptor ───────────────────────

/**
 * Internal lookup mapping each `ClaimSeverity` to its display label and
 * Tailwind colour classes. Centralised so a palette change is one edit;
 * the `Record<ClaimSeverity, …>` type catches a missing entry at
 * compile time if the enum is ever extended (Track B may add e.g.
 * `mass_loss_event` for catastrophe aggregation).
 *
 * Colour rationale (kept distinct from `ClaimStatusPill.tsx`'s palette
 * so a row carrying both pills reads as two independent dimensions):
 *   - `simple`       — emerald: low-risk, fast-track. Cool/positive tone.
 *   - `complex`      — amber:   needs adjuster attention, but routine.
 *                       Warm but not alarming.
 *   - `catastrophic` — rose, with a stronger ring: high-severity,
 *                       reinsurance-relevant, JFSA-threshold-adjacent.
 *                       Designed to draw the eye in any queue scan.
 */
interface SeverityDescriptor {
  readonly label: string;
  readonly classes: string;
}

const SEVERITY_DESCRIPTORS: Record<ClaimSeverity, SeverityDescriptor> = {
  simple: {
    label: 'Simple',
    classes: 'bg-emerald-100 text-emerald-800 ring-emerald-200',
  },
  complex: {
    label: 'Complex',
    classes: 'bg-amber-100 text-amber-800 ring-amber-200',
  },
  catastrophic: {
    label: 'Catastrophic',
    classes: 'bg-rose-100 text-rose-900 ring-rose-300',
  },
};

/**
 * Fallback descriptor for unrecognised severity strings. The narrow
 * `ClaimSeverity` type means this is unreachable through normal typed
 * code paths, but a server enum drift should not crash the page — it
 * renders the raw string in a neutral pill so support staff can see
 * what the backend sent.
 */
const UNKNOWN_SEVERITY_DESCRIPTOR: SeverityDescriptor = {
  label: 'Unknown',
  classes: 'bg-slate-100 text-slate-500 ring-slate-200',
};

function resolveDescriptor(severity: ClaimSeverity | string): SeverityDescriptor {
  const known = (SEVERITY_DESCRIPTORS as Record<string, SeverityDescriptor | undefined>)[
    severity
  ];
  if (known) {
    return known;
  }
  return {
    ...UNKNOWN_SEVERITY_DESCRIPTOR,
    label: severity || UNKNOWN_SEVERITY_DESCRIPTOR.label,
  };
}

// ─────────────────────────── component props ──────────────────────────

export interface SeverityPillProps {
  /**
   * The severity to display. Accepts `ClaimSeverity` directly (the
   * common case) or a raw string for resilience against backend enum
   * drift — see `resolveDescriptor` above.
   */
  severity: ClaimSeverity | string;
  /**
   * Optional prefix shown in front of the label, e.g. `"Severity"` or
   * `"Initial"`. Rendered inside the same pill in a muted tone so it
   * does not compete with the severity label.
   */
  prefix?: string;
  /**
   * Visual size. `'sm'` is the default and matches inline use in
   * tables and queue rows. `'md'` is used in the claim-detail header
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
   * `"Claim severity: <label>"`, which is the right answer for nearly
   * every use.
   */
  ariaLabel?: string;
}

// ───────────────────────────── component ──────────────────────────────

const SIZE_CLASSES: Record<NonNullable<SeverityPillProps['size']>, string> = {
  sm: 'px-2 py-0.5 text-xs',
  md: 'px-2.5 py-1 text-sm',
};

/**
 * Render a claim severity pill.
 *
 * @example
 *   <SeverityPill severity="catastrophic" />
 *   <SeverityPill severity={claim.severity_initial} size="md" />
 *   <SeverityPill severity={claim.severity_initial} prefix="Initial" />
 */
export function SeverityPill({
  severity,
  prefix,
  size = 'sm',
  className,
  ariaLabel,
}: SeverityPillProps): JSX.Element {
  const descriptor = resolveDescriptor(severity);
  const sizeClasses = SIZE_CLASSES[size];

  const computedAriaLabel = ariaLabel ?? `Claim severity: ${descriptor.label}`;

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

export default SeverityPill;