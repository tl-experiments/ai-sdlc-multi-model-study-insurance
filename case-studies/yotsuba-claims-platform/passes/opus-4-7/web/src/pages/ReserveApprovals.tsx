/**
 * ReserveApprovals — manager workflow for reserve proposals.
 *
 * Why this page exists
 * --------------------
 * The brief specifies an approval workflow with explicit monetary
 * tiers (ADR-005, encoded in `reserves.service.ts`):
 *
 *   - ≤ ¥1M:  self-approving (auto-approved on proposal)
 *   - ¥1M–¥10M: manager approval required
 *   - >¥10M: manager approval AND claims-director approval required
 *
 * Plus the JFSA threshold (ADR-006): any single reserve change
 * crossing ¥100M triggers a `NotificationToRegulator` record.
 *
 * Managers need a single screen to see every reserve currently
 * sitting in the `pending` state, understand which tier each falls
 * into, and act on it (approve, director-approve, or reject with a
 * reason). This page is that screen.
 *
 * The page is gated to the `manager` role at the route layer (see
 * `App.tsx`); the API additionally enforces director-approve to users
 * with `is_claims_director=true`. We surface that distinction in the
 * UI by disabling the director-approve button for managers who are
 * not directors, with a tooltip explaining why.
 *
 * Routing
 * -------
 * The page is the single child of `/reserves/approvals`. We do not
 * navigate away on action; instead we refresh the pending list in
 * place so a manager can churn through a queue without losing
 * context. Each row links to the parent claim's detail page for any
 * deeper investigation.
 *
 * Accessibility
 * -------------
 * Each row is a `<tr>` inside a labelled `<table>`. Action buttons
 * have descriptive `aria-label`s that include the reserve amount so
 * screen readers do not read a wall of identical "Approve" buttons.
 * The rejection modal traps focus, is labelled by its heading, and
 * closes on Escape.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { FormEvent, KeyboardEvent } from 'react';
import { Link } from 'react-router-dom';

import { api } from '../lib/api';
import type { Reserve, ReserveCategory } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatYen } from '../lib/format-yen';

// ─────────────────────────── approval tiers ────────────────────────────

/**
 * Approval tier thresholds in yen, mirroring ADR-005. Kept here as a
 * UI-side mirror so we can render the correct call-to-action without
 * round-tripping the server; the backend remains the source of truth
 * for what is actually accepted.
 */
const MANAGER_APPROVAL_THRESHOLD_YEN = 1_000_000n;
const DIRECTOR_APPROVAL_THRESHOLD_YEN = 10_000_000n;
const JFSA_NOTIFICATION_THRESHOLD_YEN = 100_000_000n;

type ApprovalTier = 'self_approving' | 'manager' | 'director';

function tierForAmount(amountYen: bigint): ApprovalTier {
  if (amountYen > DIRECTOR_APPROVAL_THRESHOLD_YEN) {
    return 'director';
  }
  if (amountYen > MANAGER_APPROVAL_THRESHOLD_YEN) {
    return 'manager';
  }
  return 'self_approving';
}

const TIER_LABELS: Readonly<Record<ApprovalTier, string>> = {
  self_approving: 'Self-approving (≤ ¥1M)',
  manager: 'Manager approval',
  director: 'Director approval required',
};

const CATEGORY_LABELS: Readonly<Record<ReserveCategory, string>> = {
  loss_paid: 'Loss paid',
  loss_unpaid: 'Loss unpaid',
  alae: 'ALAE',
  ulae: 'ULAE',
};

// ─────────────────────────── amount parsing ────────────────────────────

/**
 * The API returns `proposed_yen` as a string (Prisma `Decimal` is
 * serialised as a string to preserve precision). Coerce to `bigint`
 * for tier classification; fall back to `0n` on malformed input so a
 * rogue value cannot crash the render.
 */
function parseYen(raw: string | null | undefined): bigint {
  if (raw === null || raw === undefined) {
    return 0n;
  }
  // Strip a trailing `.0` if the backend chose to include one.
  const trimmed = raw.trim().split('.')[0];
  if (trimmed.length === 0) {
    return 0n;
  }
  try {
    return BigInt(trimmed);
  } catch {
    return 0n;
  }
}

function formatProposedYen(raw: string | null | undefined): string {
  return formatYen(parseYen(raw));
}

function formatDelta(prior: string | null | undefined, proposed: string | null | undefined): string {
  if (prior === null || prior === undefined) {
    return 'New';
  }
  const delta = parseYen(proposed) - parseYen(prior);
  if (delta === 0n) {
    return '±¥0';
  }
  const sign = delta > 0n ? '+' : '−';
  const magnitude = delta > 0n ? delta : -delta;
  return `${sign}${formatYen(magnitude)}`;
}

// ─────────────────────────── date formatting ───────────────────────────

function formatTimestamp(iso: string): string {
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

// ─────────────────────────── fetch lifecycle ───────────────────────────

type QueueState =
  | { readonly kind: 'idle' }
  | { readonly kind: 'loading' }
  | { readonly kind: 'error'; readonly message: string }
  | { readonly kind: 'loaded'; readonly reserves: readonly Reserve[] };

function describeError(error: unknown): string {
  if (error instanceof Error && error.message.length > 0) {
    return error.message;
  }
  if (typeof error === 'string' && error.length > 0) {
    return error;
  }
  return 'Something went wrong. Please try again.';
}

// ─────────────────────────── tier pill ─────────────────────────────────

const TIER_PILL_CLASSES: Readonly<Record<ApprovalTier, string>> = {
  self_approving: 'bg-slate-100 text-slate-700 ring-slate-200',
  manager: 'bg-amber-50 text-amber-800 ring-amber-200',
  director: 'bg-rose-50 text-rose-800 ring-rose-200',
};

function TierPill({ tier }: { readonly tier: ApprovalTier }): JSX.Element {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset ${TIER_PILL_CLASSES[tier]}`}
    >
      {TIER_LABELS[tier]}
    </span>
  );
}

// ─────────────────────────── rejection modal ───────────────────────────

interface RejectionModalProps {
  readonly reserve: Reserve;
  readonly onClose: () => void;
  readonly onSubmit: (reason: string) => Promise<void>;
}

function RejectionModal({ reserve, onClose, onSubmit }: RejectionModalProps): JSX.Element {
  const [reason, setReason] = useState<string>('');
  const [isSubmitting, setIsSubmitting] = useState<boolean>(false);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape' && !isSubmitting) {
      onClose();
    }
  };

  const handleSubmit = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (isSubmitting) {
      return;
    }
    const trimmed = reason.trim();
    if (trimmed.length === 0) {
      setErrorMessage('A reason is required to reject a reserve.');
      return;
    }
    setErrorMessage(null);
    setIsSubmitting(true);
    try {
      await onSubmit(trimmed);
    } catch (error) {
      setErrorMessage(describeError(error));
      setIsSubmitting(false);
    }
  };

  const onFormSubmit = (event: FormEvent<HTMLFormElement>): void => {
    void handleSubmit(event);
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="reject-dialog-heading"
      onKeyDown={handleKeyDown}
      className="fixed inset-0 z-20 flex items-center justify-center bg-slate-900/40 px-4 py-6"
    >
      <div className="w-full max-w-md rounded-lg border border-slate-200 bg-white p-6 shadow-lg">
        <header className="mb-4 flex flex-col gap-1">
          <h2 id="reject-dialog-heading" className="text-base font-semibold text-slate-900">
            Reject reserve proposal
          </h2>
          <p className="text-xs text-slate-500">
            Reserve {reserve.id.slice(0, 10)}… — {formatProposedYen(reserve.proposed_yen)}
          </p>
        </header>

        <form onSubmit={onFormSubmit} noValidate>
          <div className="flex flex-col gap-1">
            <label htmlFor="reject-reason" className="text-sm font-medium text-slate-700">
              Reason for rejection
            </label>
            <textarea
              ref={textareaRef}
              id="reject-reason"
              name="reason_for_rejection"
              rows={4}
              required
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              disabled={isSubmitting}
              aria-invalid={errorMessage !== null}
              className="rounded-md border border-slate-300 bg-white px-3 py-2 text-sm text-slate-900 shadow-sm transition placeholder:text-slate-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 disabled:cursor-not-allowed disabled:bg-slate-100 disabled:text-slate-500"
              placeholder="Explain why this proposal cannot be approved as submitted."
            />
          </div>

          {errorMessage ? (
            <p
              role="alert"
              className="mt-3 rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
            >
              {errorMessage}
            </p>
          ) : null}

          <div className="mt-5 flex items-center justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              disabled={isSubmitting}
              className="rounded-md border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 shadow-sm transition hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={isSubmitting}
              aria-busy={isSubmitting}
              className="inline-flex items-center justify-center rounded-md bg-rose-600 px-3 py-1.5 text-sm font-semibold text-white shadow-sm transition hover:bg-rose-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-rose-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-rose-400"
            >
              {isSubmitting ? 'Rejecting…' : 'Confirm rejection'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}

// ─────────────────────────── reserve row ───────────────────────────────

interface ReserveRowProps {
  readonly reserve: Reserve;
  readonly canDirectorApprove: boolean;
  readonly busyReserveId: string | null;
  readonly onApprove: (reserve: Reserve) => void;
  readonly onDirectorApprove: (reserve: Reserve) => void;
  readonly onReject: (reserve: Reserve) => void;
}

function ReserveRow({
  reserve,
  canDirectorApprove,
  busyReserveId,
  onApprove,
  onDirectorApprove,
  onReject,
}: ReserveRowProps): JSX.Element {
  const amount = parseYen(reserve.proposed_yen);
  const tier = tierForAmount(amount);
  const triggersJfsa = amount >= JFSA_NOTIFICATION_THRESHOLD_YEN;
  const isBusy = busyReserveId === reserve.id;

  // When a manager has already approved (tier=director, status still
  // pending), the next required action is director approval. Otherwise
  // a regular `approve` advances the workflow.
  const needsDirectorNext = tier === 'director' && reserve.approved_by_id !== null && reserve.approved_by_id !== undefined;
  const needsManagerApproval = reserve.approved_by_id === null || reserve.approved_by_id === undefined;

  return (
    <tr className="border-b border-slate-100 last:border-b-0 align-top hover:bg-slate-50">
      <td className="whitespace-nowrap px-4 py-3">
        <Link
          to={`/claims/${reserve.claim_id}`}
          className="font-mono text-xs text-indigo-700 hover:text-indigo-900 hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1"
          aria-label={`Open claim ${reserve.claim_id}`}
        >
          {reserve.claim_id.slice(0, 10)}…
        </Link>
        <div className="mt-1 font-mono text-[10px] uppercase text-slate-400">
          {reserve.id.slice(0, 10)}…
        </div>
      </td>
      <td className="px-4 py-3">
        <div className="text-sm font-semibold text-slate-900">
          {formatProposedYen(reserve.proposed_yen)}
        </div>
        <div className="mt-1 text-xs text-slate-500">
          Δ {formatDelta(reserve.prior_yen, reserve.proposed_yen)}
        </div>
        {triggersJfsa ? (
          <div className="mt-1 inline-flex items-center rounded-full bg-rose-50 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-rose-700 ring-1 ring-inset ring-rose-200">
            JFSA notification
          </div>
        ) : null}
      </td>
      <td className="px-4 py-3 text-sm text-slate-700">
        {CATEGORY_LABELS[reserve.category] ?? reserve.category}
      </td>
      <td className="px-4 py-3">
        <TierPill tier={tier} />
        {needsDirectorNext ? (
          <div className="mt-1 text-[10px] uppercase tracking-wide text-slate-500">
            Manager approved · awaiting director
          </div>
        ) : null}
      </td>
      <td className="px-4 py-3">
        <p className="max-w-md whitespace-pre-wrap text-xs text-slate-600">
          {reserve.justification}
        </p>
        <div className="mt-1 text-[10px] uppercase tracking-wide text-slate-400">
          Proposed {formatTimestamp(reserve.proposed_at)}
        </div>
      </td>
      <td className="whitespace-nowrap px-4 py-3 text-right">
        <div className="flex flex-col items-stretch gap-1.5">
          {needsManagerApproval ? (
            <button
              type="button"
              onClick={() => onApprove(reserve)}
              disabled={isBusy}
              aria-label={`Approve reserve ${reserve.id} for ${formatProposedYen(reserve.proposed_yen)}`}
              className="inline-flex items-center justify-center rounded-md bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-emerald-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-emerald-400"
            >
              {isBusy ? 'Approving…' : 'Approve'}
            </button>
          ) : null}

          {tier === 'director' ? (
            <button
              type="button"
              onClick={() => onDirectorApprove(reserve)}
              disabled={isBusy || !canDirectorApprove || needsManagerApproval}
              aria-label={`Director-approve reserve ${reserve.id} for ${formatProposedYen(reserve.proposed_yen)}`}
              title={
                canDirectorApprove
                  ? undefined
                  : 'Director approval requires the claims-director role.'
              }
              className="inline-flex items-center justify-center rounded-md bg-indigo-600 px-3 py-1.5 text-xs font-semibold text-white shadow-sm transition hover:bg-indigo-500 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:bg-indigo-300"
            >
              {isBusy ? 'Working…' : 'Director-approve'}
            </button>
          ) : null}

          <button
            type="button"
            onClick={() => onReject(reserve)}
            disabled={isBusy}
            aria-label={`Reject reserve ${reserve.id} for ${formatProposedYen(reserve.proposed_yen)}`}
            className="inline-flex items-center justify-center rounded-md border border-slate-300 bg-white px-3 py-1.5 text-xs font-medium text-slate-700 shadow-sm transition hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-60"
          >
            Reject…
          </button>
        </div>
      </td>
    </tr>
  );
}

// ─────────────────────────── page component ────────────────────────────

/**
 * Render the reserve approvals queue.
 *
 * @example
 *   <Route path="/reserves/approvals" element={<ReserveApprovals />} />
 */
export function ReserveApprovals(): JSX.Element {
  const { user } = useAuth();
  const canDirectorApprove = user?.is_claims_director === true;

  const [state, setState] = useState<QueueState>({ kind: 'idle' });
  const [busyReserveId, setBusyReserveId] = useState<string | null>(null);
  const [actionMessage, setActionMessage] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [rejectionTarget, setRejectionTarget] = useState<Reserve | null>(null);

  const loadPending = useCallback(async (): Promise<void> => {
    setState({ kind: 'loading' });
    try {
      const reserves = await api.listPendingReserves();
      setState({ kind: 'loaded', reserves });
    } catch (error) {
      setState({ kind: 'error', message: describeError(error) });
    }
  }, []);

  useEffect(() => {
    void loadPending();
  }, [loadPending]);

  const handleApprove = useCallback(
    async (reserve: Reserve): Promise<void> => {
      setBusyReserveId(reserve.id);
      setActionError(null);
      setActionMessage(null);
      try {
        await api.approveReserve(reserve.id);
        setActionMessage(
          `Approved reserve ${reserve.id.slice(0, 10)}… for ${formatProposedYen(reserve.proposed_yen)}.`,
        );
        await loadPending();
      } catch (error) {
        setActionError(describeError(error));
      } finally {
        setBusyReserveId(null);
      }
    },
    [loadPending],
  );

  const handleDirectorApprove = useCallback(
    async (reserve: Reserve): Promise<void> => {
      setBusyReserveId(reserve.id);
      setActionError(null);
      setActionMessage(null);
      try {
        await api.directorApproveReserve(reserve.id);
        setActionMessage(
          `Director-approved reserve ${reserve.id.slice(0, 10)}… for ${formatProposedYen(reserve.proposed_yen)}.`,
        );
        await loadPending();
      } catch (error) {
        setActionError(describeError(error));
      } finally {
        setBusyReserveId(null);
      }
    },
    [loadPending],
  );

  const handleRejectSubmit = useCallback(
    async (reason: string): Promise<void> => {
      const target = rejectionTarget;
      if (!target) {
        return;
      }
      setBusyReserveId(target.id);
      setActionError(null);
      setActionMessage(null);
      try {
        await api.rejectReserve(target.id, reason);
        setActionMessage(
          `Rejected reserve ${target.id.slice(0, 10)}… for ${formatProposedYen(target.proposed_yen)}.`,
        );
        setRejectionTarget(null);
        await loadPending();
      } catch (error) {
        // Re-raise so the modal can surface the error inline.
        setBusyReserveId(null);
        throw error;
      }
      setBusyReserveId(null);
    },
    [loadPending, rejectionTarget],
  );

  const handleApproveClick = (reserve: Reserve): void => {
    void handleApprove(reserve);
  };

  const handleDirectorApproveClick = (reserve: Reserve): void => {
    void handleDirectorApprove(reserve);
  };

  const handleRejectClick = (reserve: Reserve): void => {
    setRejectionTarget(reserve);
  };

  const handleRejectClose = (): void => {
    setRejectionTarget(null);
  };

  const handleRetry = (): void => {
    void loadPending();
  };

  /**
   * Group the pending reserves by tier for an at-a-glance summary at
   * the top of the page. Memoised so the reduce only re-runs when the
   * underlying list changes.
   */
  const tierCounts = useMemo<Readonly<Record<ApprovalTier, number>>>(() => {
    if (state.kind !== 'loaded') {
      return { self_approving: 0, manager: 0, director: 0 };
    }
    return state.reserves.reduce<Record<ApprovalTier, number>>(
      (acc, reserve) => {
        const tier = tierForAmount(parseYen(reserve.proposed_yen));
        acc[tier] += 1;
        return acc;
      },
      { self_approving: 0, manager: 0, director: 0 },
    );
  }, [state]);

  return (
    <div className="flex flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-xl font-semibold text-slate-900">Reserve Approvals</h1>
        <p className="text-sm text-slate-500">
          Reserve proposals awaiting your decision. Tiers follow the
          policy in ADR-005: manager approval for proposals over ¥1M,
          director approval additionally required above ¥10M. Proposals
          ≥ ¥100M trigger a JFSA notification record (ADR-006).
        </p>
      </header>

      {state.kind === 'loaded' ? (
        <section
          aria-label="Pending reserve summary"
          className="grid grid-cols-1 gap-3 sm:grid-cols-3"
        >
          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Manager-only
            </div>
            <div className="mt-1 text-2xl font-semibold text-slate-900">
              {tierCounts.manager}
            </div>
            <div className="text-xs text-slate-500">¥1M – ¥10M</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Director-required
            </div>
            <div className="mt-1 text-2xl font-semibold text-slate-900">
              {tierCounts.director}
            </div>
            <div className="text-xs text-slate-500">Over ¥10M</div>
          </div>
          <div className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
            <div className="text-xs font-semibold uppercase tracking-wide text-slate-500">
              Self-approving (legacy)
            </div>
            <div className="mt-1 text-2xl font-semibold text-slate-900">
              {tierCounts.self_approving}
            </div>
            <div className="text-xs text-slate-500">≤ ¥1M · should be auto-approved</div>
          </div>
        </section>
      ) : null}

      {actionMessage ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800"
        >
          {actionMessage}
        </div>
      ) : null}

      {actionError ? (
        <div
          role="alert"
          className="rounded-md border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-800"
        >
          {actionError}
        </div>
      ) : null}

      {!canDirectorApprove ? (
        <div className="rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          You are signed in as a manager without the claims-director
          flag. You can approve proposals up to ¥10M; proposals above
          that threshold also require a claims director.
        </div>
      ) : null}

      <section
        aria-label="Pending reserve proposals"
        aria-live="polite"
        className="rounded-lg border border-slate-200 bg-white shadow-sm"
      >
        {state.kind === 'loading' ? (
          <div className="px-4 py-10 text-center text-sm text-slate-500">
            Loading pending reserves…
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
                {state.reserves.length}{' '}
                {state.reserves.length === 1 ? 'proposal' : 'proposals'} awaiting action
              </span>
              <button
                type="button"
                onClick={handleRetry}
                className="rounded-md border border-slate-200 bg-white px-2 py-1 text-xs font-medium text-slate-600 shadow-sm transition hover:bg-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-indigo-500 focus-visible:ring-offset-1"
              >
                Refresh
              </button>
            </div>
            {state.reserves.length === 0 ? (
              <div className="px-4 py-10 text-center text-sm text-slate-500">
                No reserve proposals are currently awaiting approval.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wide text-slate-500">
                    <tr>
                      <th scope="col" className="px-4 py-2 font-semibold">
                        Claim · Reserve
                      </th>
                      <th scope="col" className="px-4 py-2 font-semibold">
                        Amount
                      </th>
                      <th scope="col" className="px-4 py-2 font-semibold">
                        Category
                      </th>
                      <th scope="col" className="px-4 py-2 font-semibold">
                        Tier
                      </th>
                      <th scope="col" className="px-4 py-2 font-semibold">
                        Justification
                      </th>
                      <th scope="col" className="px-4 py-2 text-right font-semibold">
                        Actions
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {state.reserves.map((reserve) => (
                      <ReserveRow
                        key={reserve.id}
                        reserve={reserve}
                        canDirectorApprove={canDirectorApprove}
                        busyReserveId={busyReserveId}
                        onApprove={handleApproveClick}
                        onDirectorApprove={handleDirectorApproveClick}
                        onReject={handleRejectClick}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </>
        ) : null}

        {state.kind === 'idle' ? (
          <div className="px-4 py-10 text-center text-sm text-slate-500">
            Preparing approvals…
          </div>
        ) : null}
      </section>

      {rejectionTarget ? (
        <RejectionModal
          reserve={rejectionTarget}
          onClose={handleRejectClose}
          onSubmit={handleRejectSubmit}
        />
      ) : null}
    </div>
  );
}

export default ReserveApprovals;