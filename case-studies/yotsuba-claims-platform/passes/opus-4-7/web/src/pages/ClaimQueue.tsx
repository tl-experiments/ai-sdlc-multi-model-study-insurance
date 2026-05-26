/**
 * ClaimQueue — filterable list of claims, the Workbench's landing page.
 *
 * Why this page exists
 * --------------------
 * After sign-in, every Workbench user lands on a list of claims. The
 * brief specifies a queue with "filter chips (status, severity,
 * channel, age)" and "quick actions" — this page is the realisation of
 * that scope. It is deliberately read-mostly: it surfaces what each
 * caller is allowed to see (role-scoped server-side; further
 * client-side filtering on top) and links into `ClaimDetail.tsx` for
 * any mutating action.
 *
 * The page calls `GET /claims` with the active filter values; the
 * backend applies role-based scoping (an `adjuster` only sees claims
 * assigned to them, an `auditor` sees all with masked PII, etc.), so
 * this component never has to think about RBAC beyond rendering what
 * came back. Client-side state is limited to:
 *
 *   - The current filter selections (status, severity, channel, age
 *     bucket). Each is independent; `undefined` means "any".
 *   - The fetch lifecycle (idle / loading / error / loaded).
 *
 * Filter chips are rendered as toggle buttons so a keyboard user can
 * tab through and `Space`/`Enter` to flip them. The active chip carries
 * `aria-pressed="true"` so assistive tech announces state changes.
 *
 * Age bucket is a client-side concept derived from `created_at` — the
 * API does not (in Track A) expose an `age` query parameter, so we
 * filter post-fetch. The buckets mirror the operational language used
 * by the brief's role matrix ("agent — own intake (24h)" etc.):
 *
 *   - `today`        — created within the last 24 hours
 *   - `this_week`    — created within the last 7 days
 *   - `older`        — anything else
 *
 * Accessibility
 * -------------
 * The filter region is a `<section>` with an `aria-label`. Each filter
 * group is a `<fieldset>` with a `<legend>` so screen readers announce
 * the group's purpose. The results region is an `aria-live="polite"`
 * container so the count update is announced when filters change. The
 * empty state, error state, and loading state each render a distinct
 * message rather than blanking the page.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../lib/api';
import type {
  Claim,
  ClaimSeverity,
  ClaimStatus,
  IntakeChannel,
} from '../lib/api';
import { ClaimStatusPill } from '../components/ClaimStatusPill';
import { SeverityPill } from '../components/SeverityPill';

// ─────────────────────────── filter descriptors ────────────────────────

/**
 * Tuple of all `ClaimStatus` values, in the workflow order specified
 * by `brief.md` § FNOL / Workbench. Centralised so a future status
 * addition is one edit; the `readonly` keeps callers from mutating
 * the canonical order.
 */
const STATUS_OPTIONS: readonly ClaimStatus[] = [
  'intake',
  'under_investigation',
  'awaiting_reserve_approval',
  'settlement_offered',
  'closed_paid',
  'closed_denied',
  'reopened',
];

const SEVERITY_OPTIONS: readonly ClaimSeverity[] = ['simple', 'complex', 'catastrophic'];

const CHANNEL_OPTIONS: readonly IntakeChannel[] = ['agent', 'mobile', 'broker', 'email'];

/**
 * Client-side age buckets, computed from `created_at`. The labels are
 * intentionally short so the chip row stays compact at narrow widths.
 */
type AgeBucket = 'today' | 'this_week' | 'older';

const AGE_OPTIONS: readonly AgeBucket[] = ['today', 'this_week', 'older'];

const STATUS_LABELS: Readonly<Record<ClaimStatus, string>> = {
  intake: 'Intake',
  under_investigation: 'Under investigation',
  awaiting_reserve_approval: 'Awaiting reserve approval',
  settlement_offered: 'Settlement offered',
  closed_paid: 'Closed (paid)',
  closed_denied: 'Closed (denied)',
  reopened: 'Reopened',
};

const SEVERITY_LABELS: Readonly<Record<ClaimSeverity, string>> = {
  simple: 'Simple',
  complex: 'Complex',
  catastrophic: 'Catastrophic',
};

const CHANNEL_LABELS: Readonly<Record<IntakeChannel, string>> = {
  agent: 'Agent',
  mobile: 'Mobile',
  broker: 'Broker',
  email: 'Email',
};

const AGE_LABELS: Readonly<Record<AgeBucket, string>> = {
  today: 'Today',
  this_week: 'This week',
  older: 'Older',
};

// ─────────────────────────── filter state ──────────────────────────────

/**
 * The full client-side filter selection. Each field is `undefined`
 * when no filter is active for that dimension. Keeping all four
 * dimensions in a single object makes "clear all" a one-line reset
 * and avoids the cartesian explosion of independent `useState` calls.
 */
interface FilterState {
  status?: ClaimStatus;
  severity?: ClaimSeverity;
  channel?: IntakeChannel;
  age?: AgeBucket;
}

const EMPTY_FILTERS: FilterState = {};

function hasActiveFilter(state: FilterState): boolean {
  return (
    state.status !== undefined ||
    state.severity !== undefined ||
    state.channel !== undefined ||
    state.age !== undefined
  );
}

// ─────────────────────────── age bucketing ─────────────────────────────

const MS_PER_HOUR = 60 * 60 * 1000;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Categorise a claim's `created_at` into one of the age buckets. A
 * malformed timestamp falls into `older` so it remains visible rather
 * than vanishing silently from the queue.
 */
function bucketForCreatedAt(iso: string, now: number): AgeBucket {
  const parsed = new Date(iso).getTime();
  if (Number.isNaN(parsed)) {
    return 'older';
  }
  const ageMs = now - parsed;
  if (ageMs < MS_PER_DAY) {
    return 'today';
  }
  if (ageMs < 7 * MS_PER_DAY) {
    return 'this_week';
  }
  return 'older';
}

// ─────────────────────────── formatting helpers ────────────────────────

function formatCreatedAt(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function formatLossDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return iso;
  }
  return date.toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: '2-digit',
  });
}

/**
 * The `incident_type` enum values are snake_case for the API; humans
 * want spaces. A single mapping avoids scattering `replace(/_/g, ' ')`
 * calls throughout the page.
 */
function humaniseIncidentType(value: string): string {
  return value
    .split('_')
    .map((part) => (part.length === 0 ? part : part[0].toUpperCase() + part.slice(1)))
    .join(' ');
}

// ─────────────────────────── fetch lifecycle ───────────────────────────

/**
 * Discriminated union for the queue's load state. Modelling the
 * lifecycle as a sum type keeps the render logic from drifting into
 * the "empty array but also loading and also has an error" tangle that
 * plagues naive `useState` setups.
 */
type QueueState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'loaded'; readonly claims: readonly Claim[] };

function describeFetchError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  if (typeof error === 'string' && error.length > 0) {
    return error;
  }
  return 'Failed to load claims. Please try again.';
}

// ─────────────────────────── chip styling ──────────────────────────────

const CHIP_BASE_CLASSES =
  'inline-flex items-center rounded-full px-3 py-1 text-xs font-medium ring-1 ring-inset transition focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1';

const CHIP_INACTIVE_CLASSES =
  'bg-white text-slate-700 ring-slate-300 hover:bg-slate-50';

const CHIP_ACTIVE_CLASSES = 'bg-indigo-600 text-white ring-indigo-600 hover:bg-indigo-500';

function chipClassName(isActive: boolean): string {
  return [CHIP_BASE_CLASSES, isActive ? CHIP_ACTIVE_CLASSES : CHIP_INACTIVE_CLASSES].join(
    ' ',
  );
}

// ─────────────────────────── filter chip group ─────────────────────────

interface FilterChipGroupProps<T extends string> {
  readonly legend: string;
  readonly options: readonly T[];
  readonly labels: Readonly<Record<T, string>>;
  readonly active: T | undefined;
  readonly onSelect: (value: T | undefined) => void;
}

/**
 * Render a single dimension of filters as a row of toggle chips. The
 * generic parameter `T` lets us reuse this for every enum without
 * sacrificing type safety on the `labels` lookup or the `onSelect`
 * callback's argument.
 */
function FilterChipGroup<T extends string>({
  legend,
  options,
  labels,
  active,
  onSelect,
}: FilterChipGroupProps<T>): JSX.Element {
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="text-xs font-semibold uppercase tracking-wide text-slate-500">
        {legend}
      </legend>
      <div className="flex flex-wrap items-center gap-1.5" role="group" aria-label={legend}>
        {options.map((option) => {
          const isActive = active === option;
          return (
            <button
              key={option}
              type="button"
              className={chipClassName(isActive)}
              aria-pressed={isActive}
              onClick={() => onSelect(isActive ? undefined : option)}
            >
              {labels[option]}
            </button>
          );
        })}
      </div>
    </fieldset>
  );
}

// ─────────────────────────── claim row ─────────────────────────────────

interface ClaimRowProps {
  readonly claim: Claim;
}

function ClaimRow({ claim }: ClaimRowProps): JSX.Element {
  return (
    <tr className="border-b border-slate-100 last:border-b-0 hover:bg-slate-50">
      <td className="whitespace-nowrap px-4 py-3 align-top">
        <Link
          to={`/claims/${claim.id}`}
          className="font-mono text-xs text-indigo-700 hover:text-indigo-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1"
          aria-label={`Open claim ${claim.id}`}
        >
          {claim.id.slice(0, 10)}…
        </Link>
        <div className="mt-1 text-xs text-slate-500" title={claim.policy_number}>
          {claim.policy_number}
        </div>
      </td>
      <td className="px-4 py-3 align-top">
        <div className="text-sm font-medium text-slate-800">
          {humaniseIncidentType(claim.incident_type)}
        </div>
        <div className="mt-1 text-xs text-slate-500">
          Loss {formatLossDate(claim.loss_date)} ·{' '}
          {claim.loss_location_prefecture || '—'}
        </div>
      </td>
      <td className="px-4 py-3 align-top">
        <ClaimStatusPill status={claim.status} />
      </td>
      <td className="px-4 py-3 align-top">
        <SeverityPill severity={claim.severity_initial} />
      </td>
      <td className="px-4 py-3 align-top text-xs text-slate-600">
        {CHANNEL_LABELS[claim.reported_by_channel] ?? claim.reported_by_channel}
      </td>
      <td className="px-4 py-3 align-top text-xs text-slate-600">
        {formatCreatedAt(claim.created_at)}
      </td>
    </tr>
  );
}

// ─────────────────────────── page component ────────────────────────────

/**
 * Render the filterable claim queue.
 *
 * @example
 *   <Route path="/claims" element={<ClaimQueue />} />
 */
export function ClaimQueue(): JSX.Element {
  const [filters, setFilters] = useState<FilterState>(EMPTY_FILTERS);
  const [state, setState] = useState<QueueState>({ kind: 'idle' });

  /**
   * Fetch claims from the API, applying the server-side filter
   * dimensions (status, severity, channel). Age is purely client-side.
   * Wrapped in `useCallback` so the effect's dependency array is
   * stable and an unrelated render does not re-trigger the network.
   */
  const loadClaims = useCallback(async (active: FilterState): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const claims = await api.listClaims({
        status: active.status,
        severity: active.severity,
        channel: active.channel,
      });
      setState({ kind: 'loaded', claims });
    } catch (error) {
      setState({ kind: 'error', message: describeFetchError(error) });
    }
  }, []);

  useEffect(() => {
    void loadClaims(filters);
  }, [filters, loadClaims]);

  /**
   * Apply the client-side age filter on top of whatever the server
   * returned. Memoised against the loaded claim set and the active
   * bucket so re-renders triggered by hover / focus do not re-walk
   * the array.
   */
  const visibleClaims = useMemo<readonly Claim[]>(() => {
    if (state.kind !== 'loaded') {
      return [];
    }
    if (filters.age === undefined) {
      return state.claims;
    }
    const now = Date.now();
    const target = filters.age;
    return state.claims.filter((claim) => bucketForCreatedAt(claim.created_at, now) === target);
  }, [state, filters.age]);

  const handleClearFilters = (): void => {
    setFilters(EMPTY_FILTERS);
  };

  const handleRetry = (): void => {
    void loadClaims(filters);
  };

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-slate-900">Claim Queue</h1>
        <p className="text-sm text-slate-500">
          Claims you are authorised to see, filterable by status, severity,
          intake channel, and age. Selection scope is enforced server-side
          against your role.
        </p>
      </header>

      <section
        aria-label="Filters"
        className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm"
      >
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-4">
          <FilterChipGroup
            legend="Status"
            options={STATUS_OPTIONS}
            labels={STATUS_LABELS}
            active={filters.status}
            onSelect={(value) => setFilters((prev) => ({ ...prev, status: value }))}
          />
          <FilterChipGroup
            legend="Severity"
            options={SEVERITY_OPTIONS}
            labels={SEVERITY_LABELS}
            active={filters.severity}
            onSelect={(value) => setFilters((prev) => ({ ...prev, severity: value }))}
          />
          <FilterChipGroup
            legend="Channel"
            options={CHANNEL_OPTIONS}
            labels={CHANNEL_LABELS}
            active={filters.channel}
            onSelect={(value) => setFilters((prev) => ({ ...prev, channel: value }))}
          />
          <FilterChipGroup
            legend="Age"
            options={AGE_OPTIONS}
            labels={AGE_LABELS}
            active={filters.age}
            onSelect={(value) => setFilters((prev) => ({ ...prev, age: value }))}
          />
        </div>

        {hasActiveFilter(filters) ? (
          <div className="mt-4 flex items-center justify-end">
            <button
              type="button"
              onClick={handleClearFilters}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm transition hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
            >
              Clear all filters
            </button>
          </div>
        ) : null}
      </section>

      <section
        aria-label="Claim results"
        aria-live="polite"
        className="rounded-lg border border-slate-200 bg-white shadow-sm"
      >
        {state.kind === 'loading' ? (
          <div className="px-4 py-10 text-center text-sm text-slate-500">
            Loading claims…
          </div>
        ) : null}

        {state.kind === 'error' ? (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
            <p
              role="alert"
              className="max-w-md rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
            >
              {state.message}
            </p>
            <button
              type="button"
              onClick={handleRetry}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2"
            >
              Try again
            </button>
          </div>
        ) : null}

        {state.kind === 'loaded' ? (
          <>
            <div className="flex items-center justify-between border-b border-slate-200 px-4 py-2 text-xs text-slate-500">
              <span>
                {visibleClaims.length} of {state.claims.length}{' '}
                {state.claims.length === 1 ? 'claim' : 'claims'}
              </span>
            </div>
            {visibleClaims.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-slate-500">
                {state.claims.length === 0
                  ? 'No claims are visible to you at this time.'
                  : 'No claims match the current filters.'}
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th scope="col" className="px-4 py-2 font-semibold">
                        Claim · Policy
                      </th>
                      <th scope="col" className="px-4 py-2 font-semibold">
                        Incident
                      </th>
                      <th scope="col" className="px-4 py-2 font-semibold">
                        Status
                      </th>
                      <th scope="col" className="px-4 py-2 font-semibold">
                        Severity
                      </th>
                      <th scope="col" className="px-4 py-2 font-semibold">
                        Channel
                      </th>
                      <th scope="col" className="px-4 py-2 font-semibold">
                        Created
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {visibleClaims.map((claim) => (
                      <ClaimRow key={claim.id} claim={claim} />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}

        {state.kind === 'idle' ? (
          <div className="px-4 py-10 text-center text-sm text-slate-500">
            Preparing queue…
          </div>
        ) : null}
      </section>
    </div>
  );
}

export default ClaimQueue;