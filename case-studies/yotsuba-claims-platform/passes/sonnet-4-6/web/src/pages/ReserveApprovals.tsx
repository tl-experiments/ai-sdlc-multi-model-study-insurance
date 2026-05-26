/**
 * ReserveApprovals.tsx
 *
 * Manager workflow page for reviewing and approving/rejecting reserve proposals.
 *
 * Design constraints (from design.md §2, brief.md §3):
 *  - Consumes POST /reserves/:id/approve, /director-approve, /reject
 *  - Displays pending reserves for the manager's reports pool
 *  - Approval tiers: ≤¥1M self-approving; ¥1M–¥10M manager-approve;
 *    >¥10M requires manager + claims_director (is_claims_director=true)
 *  - Decimal yen values displayed via format-yen.ts helper
 *  - Role-aware: shows director-approve button only if user.is_claims_director
 *  - Tailwind-only styling; no inline styles
 *  - No `any`; strict TypeScript throughout
 *  - Handles loading, error, empty, and optimistic-update states
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/auth';
import { formatYen } from '../lib/format-yen';
import type { ReserveCategory, ApprovalStatus } from '../lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ReserveItem {
  id: string;
  claim_id: string;
  category: ReserveCategory;
  proposed_yen: string; // Decimal comes as string from JSON
  prior_yen: string | null;
  justification: string;
  proposed_by_id: string;
  proposed_by_name?: string;
  proposed_at: string;
  approval_status: ApprovalStatus;
  approved_by_id: string | null;
  approved_at: string | null;
  director_approved_by_id: string | null;
  director_approved_at: string | null;
  reason_for_rejection: string | null;
  claim?: {
    policy_number: string;
    incident_type: string;
    severity_initial: string;
    status: string;
  };
}

type ApprovalFilter = 'pending' | 'approved' | 'rejected' | 'all';

interface ActionState {
  reserveId: string;
  action: 'approve' | 'director-approve' | 'reject';
}

interface RejectModalState {
  reserveId: string;
  reason: string;
  error: string | null;
}

// ─── Constants ────────────────────────────────────────────────────────────────

const MANAGER_APPROVE_THRESHOLD = 1_000_000; // ¥1M
const DIRECTOR_APPROVE_THRESHOLD = 10_000_000; // ¥10M
const JFSA_THRESHOLD = 100_000_000; // ¥100M

const CATEGORY_LABELS: Record<ReserveCategory, string> = {
  loss_paid: 'Loss Paid',
  loss_unpaid: 'Loss Unpaid',
  alae: 'ALAE',
  ulae: 'ULAE',
};

const STATUS_STYLES: Record<ApprovalStatus, string> = {
  pending: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  approved: 'bg-green-50 text-green-700 ring-green-600/20',
  rejected: 'bg-red-50 text-red-700 ring-red-600/20',
};

const STATUS_LABELS: Record<ApprovalStatus, string> = {
  pending: 'Pending',
  approved: 'Approved',
  rejected: 'Rejected',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function parseYen(value: string | null): number {
  if (value === null) return 0;
  return Number(value);
}

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-JP', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

function getApprovalTierLabel(amountYen: number): string {
  if (amountYen > DIRECTOR_APPROVE_THRESHOLD) return 'Director Approval Required';
  if (amountYen > MANAGER_APPROVE_THRESHOLD) return 'Manager Approval Required';
  return 'Self-Approving';
}

function getApprovalTierColour(amountYen: number): string {
  if (amountYen > DIRECTOR_APPROVE_THRESHOLD) return 'text-red-600 bg-red-50 ring-red-600/20';
  if (amountYen > MANAGER_APPROVE_THRESHOLD) return 'text-amber-600 bg-amber-50 ring-amber-600/20';
  return 'text-green-600 bg-green-50 ring-green-600/20';
}

function isJfsaThreshold(amountYen: number): boolean {
  return amountYen >= JFSA_THRESHOLD;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * `<ReserveApprovals>` — manager workflow page for reserve proposals.
 *
 * Lists pending (and optionally all) reserve proposals from the manager's
 * reports pool. Supports approve, director-approve, and reject actions with
 * inline confirmation and rejection reason modals.
 *
 * @example
 * ```tsx
 * <Route path="/reserves/approvals" element={<ReserveApprovals />} />
 * ```
 */
export function ReserveApprovals(): React.ReactElement {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [reserves, setReserves] = useState<ReserveItem[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<ApprovalFilter>('pending');
  const [actionInFlight, setActionInFlight] = useState<ActionState | null>(null);
  const [rejectModal, setRejectModal] = useState<RejectModalState | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);

  const fetchReserves = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (filter !== 'all') params.set('approval_status', filter);
      const data = await apiFetch<ReserveItem[]>(`/reserves/pending?${params.toString()}`);
      setReserves(data);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to load reserve proposals.',
      );
    } finally {
      setIsLoading(false);
    }
  }, [filter]);

  useEffect(() => {
    void fetchReserves();
  }, [fetchReserves]);

  // Flash success banner then clear it.
  useEffect(() => {
    if (actionSuccess === null) return;
    const timer = window.setTimeout(() => setActionSuccess(null), 4000);
    return () => window.clearTimeout(timer);
  }, [actionSuccess]);

  const handleApprove = useCallback(
    async (reserveId: string, isDirector: boolean): Promise<void> => {
      const action = isDirector ? 'director-approve' : 'approve';
      setActionInFlight({ reserveId, action });
      try {
        const endpoint = isDirector
          ? `/reserves/${reserveId}/director-approve`
          : `/reserves/${reserveId}/approve`;
        await apiFetch(endpoint, { method: 'POST' });
        setReserves((prev) =>
          prev.map((r) =>
            r.id === reserveId ? { ...r, approval_status: 'approved' } : r,
          ),
        );
        setActionSuccess(
          isDirector
            ? 'Reserve approved at director level.'
            : 'Reserve approved successfully.',
        );
        // Remove from pending list after a brief delay.
        if (filter === 'pending') {
          window.setTimeout(() => {
            setReserves((prev) => prev.filter((r) => r.id !== reserveId));
          }, 1500);
        }
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Approval failed. Please try again.',
        );
      } finally {
        setActionInFlight(null);
      }
    },
    [filter],
  );

  const handleOpenRejectModal = useCallback((reserveId: string): void => {
    setRejectModal({ reserveId, reason: '', error: null });
  }, []);

  const handleCloseRejectModal = useCallback((): void => {
    setRejectModal(null);
  }, []);

  const handleRejectReasonChange = useCallback(
    (e: React.ChangeEvent<HTMLTextAreaElement>): void => {
      setRejectModal((prev) =>
        prev !== null ? { ...prev, reason: e.target.value, error: null } : null,
      );
    },
    [],
  );

  const handleSubmitRejection = useCallback(async (): Promise<void> => {
    if (rejectModal === null) return;
    if (rejectModal.reason.trim().length < 10) {
      setRejectModal((prev) =>
        prev !== null
          ? { ...prev, error: 'Rejection reason must be at least 10 characters.' }
          : null,
      );
      return;
    }
    const { reserveId, reason } = rejectModal;
    setActionInFlight({ reserveId, action: 'reject' });
    try {
      await apiFetch(`/reserves/${reserveId}/reject`, {
        method: 'POST',
        body: JSON.stringify({ reason_for_rejection: reason.trim() }),
      });
      setReserves((prev) =>
        prev.map((r) =>
          r.id === reserveId
            ? { ...r, approval_status: 'rejected', reason_for_rejection: reason.trim() }
            : r,
        ),
      );
      setActionSuccess('Reserve proposal rejected.');
      setRejectModal(null);
      if (filter === 'pending') {
        window.setTimeout(() => {
          setReserves((prev) => prev.filter((r) => r.id !== reserveId));
        }, 1500);
      }
    } catch (err) {
      setRejectModal((prev) =>
        prev !== null
          ? {
              ...prev,
              error:
                err instanceof Error ? err.message : 'Rejection failed. Please try again.',
            }
          : null,
      );
    } finally {
      setActionInFlight(null);
    }
  }, [rejectModal, filter]);

  const isClaimsDirector = user?.is_claims_director === true;

  const pendingCount = reserves.filter((r) => r.approval_status === 'pending').length;

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Reserve Approvals</h1>
          <p className="mt-1 text-sm text-gray-500">
            {isLoading
              ? 'Loading reserve proposals…'
              : `${reserves.length.toLocaleString()} proposal${
                  reserves.length !== 1 ? 's' : ''
                }${
                  filter === 'pending' ? ' pending review' : ''
                }`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {isClaimsDirector && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-indigo-50 px-3 py-1 text-xs font-medium text-indigo-700 ring-1 ring-inset ring-indigo-600/20">
              <ShieldCheckIcon className="h-3.5 w-3.5" />
              Claims Director
            </span>
          )}
          <button
            type="button"
            onClick={() => void fetchReserves()}
            disabled={isLoading}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
          >
            <RefreshIcon
              className={['h-4 w-4', isLoading ? 'animate-spin' : ''].join(' ')}
            />
            Refresh
          </button>
        </div>
      </div>

      {/* Success banner */}
      {actionSuccess !== null && (
        <div
          role="status"
          aria-live="polite"
          className="flex items-center gap-3 rounded-lg bg-green-50 px-4 py-3 ring-1 ring-inset ring-green-200"
        >
          <CheckCircleIcon className="h-4 w-4 flex-shrink-0 text-green-500" aria-hidden />
          <p className="text-sm text-green-700">{actionSuccess}</p>
        </div>
      )}

      {/* Error banner */}
      {error !== null && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg bg-red-50 px-4 py-3 ring-1 ring-inset ring-red-200"
        >
          <AlertIcon className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-500" aria-hidden />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-red-700">Error</p>
            <p className="mt-0.5 text-xs text-red-600">{error}</p>
          </div>
          <button
            type="button"
            onClick={() => { setError(null); void fetchReserves(); }}
            className="ml-auto flex-shrink-0 rounded px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Filter tabs */}
      <div className="flex items-center gap-1 rounded-xl bg-gray-100 p-1">
        {(['pending', 'approved', 'rejected', 'all'] as ApprovalFilter[]).map((f) => (
          <button
            key={f}
            type="button"
            onClick={() => setFilter(f)}
            className={[
              'flex-1 rounded-lg px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500',
              filter === f
                ? 'bg-white text-gray-900 shadow-sm ring-1 ring-gray-200'
                : 'text-gray-500 hover:text-gray-700',
            ].join(' ')}
            aria-pressed={filter === f}
          >
            {f === 'pending' ? (
              <span className="flex items-center justify-center gap-1.5">
                Pending
                {pendingCount > 0 && filter !== 'pending' && (
                  <span className="inline-flex h-4 min-w-[1rem] items-center justify-center rounded-full bg-amber-500 px-1 text-xs font-bold text-white">
                    {pendingCount}
                  </span>
                )}
              </span>
            ) : (
              <span className="capitalize">{f}</span>
            )}
          </button>
        ))}
      </div>

      {/* Approval tier legend */}
      <div className="rounded-xl bg-blue-50 px-4 py-3 ring-1 ring-inset ring-blue-200">
        <p className="text-xs font-semibold text-blue-700 mb-1.5">Approval Tiers</p>
        <div className="flex flex-wrap gap-4 text-xs text-blue-600">
          <span>≤ ¥1M — Self-approving (no action needed)</span>
          <span>¥1M – ¥10M — Manager approval required</span>
          <span>&gt; ¥10M — Claims Director approval required</span>
          <span>≥ ¥100M — JFSA threshold notification triggered</span>
        </div>
      </div>

      {/* Reserve list */}
      {isLoading ? (
        <ReserveListSkeleton />
      ) : reserves.length === 0 ? (
        <ReserveEmptyState filter={filter} />
      ) : (
        <div className="space-y-4">
          {reserves.map((reserve) => (
            <ReserveCard
              key={reserve.id}
              reserve={reserve}
              isClaimsDirector={isClaimsDirector}
              actionInFlight={actionInFlight}
              onApprove={handleApprove}
              onOpenRejectModal={handleOpenRejectModal}
              onNavigateToClaim={(claimId) => navigate(`/claims/${claimId}`)}
            />
          ))}
        </div>
      )}

      {/* Reject modal */}
      {rejectModal !== null && (
        <RejectModal
          modal={rejectModal}
          isSubmitting={
            actionInFlight?.reserveId === rejectModal.reserveId &&
            actionInFlight.action === 'reject'
          }
          onClose={handleCloseRejectModal}
          onReasonChange={handleRejectReasonChange}
          onSubmit={() => void handleSubmitRejection()}
        />
      )}
    </div>
  );
}

// ─── Reserve card ─────────────────────────────────────────────────────────────

interface ReserveCardProps {
  reserve: ReserveItem;
  isClaimsDirector: boolean;
  actionInFlight: ActionState | null;
  onApprove: (reserveId: string, isDirector: boolean) => Promise<void>;
  onOpenRejectModal: (reserveId: string) => void;
  onNavigateToClaim: (claimId: string) => void;
}

function ReserveCard({
  reserve,
  isClaimsDirector,
  actionInFlight,
  onApprove,
  onOpenRejectModal,
  onNavigateToClaim,
}: ReserveCardProps): React.ReactElement {
  const amountYen = parseYen(reserve.proposed_yen);
  const priorYen = parseYen(reserve.prior_yen);
  const delta = priorYen > 0 ? amountYen - priorYen : null;
  const tierLabel = getApprovalTierLabel(amountYen);
  const tierColour = getApprovalTierColour(amountYen);
  const jfsa = isJfsaThreshold(amountYen);

  const needsDirectorApproval = amountYen > DIRECTOR_APPROVE_THRESHOLD;
  const needsManagerApproval = amountYen > MANAGER_APPROVE_THRESHOLD;

  const isPending = reserve.approval_status === 'pending';
  const isThisActionInFlight =
    actionInFlight !== null && actionInFlight.reserveId === reserve.id;
  const isApproveInFlight =
    isThisActionInFlight && actionInFlight.action === 'approve';
  const isDirectorApproveInFlight =
    isThisActionInFlight && actionInFlight.action === 'director-approve';
  const isRejectInFlight =
    isThisActionInFlight && actionInFlight.action === 'reject';
  const anyActionInFlight = actionInFlight !== null;

  // Director can approve >¥10M; manager can approve ¥1M–¥10M.
  const canDirectorApprove = isClaimsDirector && needsDirectorApproval;
  const canManagerApprove = needsManagerApproval && !needsDirectorApproval;
  // If >¥10M and not director, manager can still see but cannot approve alone.
  const managerCannotApproveAlone = needsDirectorApproval && !isClaimsDirector;

  return (
    <div
      className={[
        'rounded-xl bg-white shadow-sm ring-1 transition-opacity',
        reserve.approval_status === 'approved'
          ? 'ring-green-200'
          : reserve.approval_status === 'rejected'
          ? 'ring-red-200'
          : 'ring-gray-200',
        isThisActionInFlight ? 'opacity-70' : 'opacity-100',
      ].join(' ')}
    >
      {/* Card header */}
      <div className="flex flex-col gap-3 border-b border-gray-100 px-5 py-4 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex flex-wrap items-center gap-2">
          {/* Approval status */}
          <span
            className={[
              'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-semibold ring-1 ring-inset',
              STATUS_STYLES[reserve.approval_status],
            ].join(' ')}
          >
            {STATUS_LABELS[reserve.approval_status]}
          </span>

          {/* Category */}
          <span className="inline-flex items-center rounded-full bg-gray-50 px-2.5 py-0.5 text-xs font-medium text-gray-600 ring-1 ring-inset ring-gray-500/20">
            {CATEGORY_LABELS[reserve.category]}
          </span>

          {/* Approval tier */}
          <span
            className={[
              'inline-flex items-center rounded-full px-2.5 py-0.5 text-xs font-medium ring-1 ring-inset',
              tierColour,
            ].join(' ')}
          >
            {tierLabel}
          </span>

          {/* JFSA threshold indicator */}
          {jfsa && (
            <span className="inline-flex items-center gap-1 rounded-full bg-red-100 px-2.5 py-0.5 text-xs font-bold text-red-700 ring-1 ring-inset ring-red-600/30">
              <ExclamationIcon className="h-3 w-3" />
              JFSA Threshold
            </span>
          )}
        </div>

        {/* Claim link */}
        <button
          type="button"
          onClick={() => onNavigateToClaim(reserve.claim_id)}
          className="flex-shrink-0 rounded-lg px-3 py-1.5 text-xs font-medium text-indigo-600 ring-1 ring-indigo-200 hover:bg-indigo-50 transition-colors"
        >
          View Claim →
        </button>
      </div>

      {/* Card body */}
      <div className="px-5 py-4 space-y-4">
        {/* Amount row */}
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <AmountBlock
            label="Proposed Reserve"
            value={formatYen(amountYen)}
            highlight
          />
          {reserve.prior_yen !== null && (
            <AmountBlock
              label="Prior Reserve"
              value={formatYen(priorYen)}
            />
          )}
          {delta !== null && (
            <AmountBlock
              label="Change"
              value={
                (delta >= 0 ? '+' : '') + formatYen(delta)
              }
              positive={delta >= 0}
            />
          )}
        </div>

        {/* Meta row */}
        <div className="grid grid-cols-1 gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-4">
          <MetaField label="Claim ID" value={reserve.claim_id.slice(0, 8).toUpperCase()} mono />
          {reserve.claim?.policy_number !== undefined && (
            <MetaField label="Policy" value={reserve.claim.policy_number} mono />
          )}
          <MetaField
            label="Proposed By"
            value={reserve.proposed_by_name ?? reserve.proposed_by_id.slice(0, 8)}
          />
          <MetaField label="Proposed At" value={formatDate(reserve.proposed_at)} />
        </div>

        {/* Justification */}
        <div>
          <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-gray-400">
            Justification
          </p>
          <p className="rounded-lg bg-gray-50 px-4 py-3 text-sm text-gray-700 ring-1 ring-inset ring-gray-200">
            {reserve.justification}
          </p>
        </div>

        {/* Rejection reason (if rejected) */}
        {reserve.approval_status === 'rejected' &&
          reserve.reason_for_rejection !== null && (
            <div>
              <p className="mb-1 text-xs font-semibold uppercase tracking-wider text-red-400">
                Rejection Reason
              </p>
              <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 ring-1 ring-inset ring-red-200">
                {reserve.reason_for_rejection}
              </p>
            </div>
          )}

        {/* Director approval note */}
        {managerCannotApproveAlone && isPending && (
          <div className="flex items-start gap-2 rounded-lg bg-amber-50 px-4 py-3 ring-1 ring-inset ring-amber-200">
            <AlertIcon className="mt-0.5 h-4 w-4 flex-shrink-0 text-amber-500" aria-hidden />
            <p className="text-sm text-amber-700">
              This reserve exceeds ¥10M and requires Claims Director approval. You
              cannot approve this proposal alone.
            </p>
          </div>
        )}

        {/* Action buttons */}
        {isPending && (
          <div className="flex flex-wrap items-center gap-3 pt-1">
            {/* Manager approve (¥1M–¥10M only) */}
            {canManagerApprove && (
              <ActionButton
                variant="approve"
                isLoading={isApproveInFlight}
                disabled={anyActionInFlight}
                onClick={() => void onApprove(reserve.id, false)}
              >
                Approve
              </ActionButton>
            )}

            {/* Director approve (>¥10M, only for claims directors) */}
            {canDirectorApprove && (
              <ActionButton
                variant="director-approve"
                isLoading={isDirectorApproveInFlight}
                disabled={anyActionInFlight}
                onClick={() => void onApprove(reserve.id, true)}
              >
                <ShieldCheckIcon className="h-3.5 w-3.5" />
                Director Approve
              </ActionButton>
            )}

            {/* Reject (any manager can reject) */}
            {!managerCannotApproveAlone || isClaimsDirector ? (
              <ActionButton
                variant="reject"
                isLoading={isRejectInFlight}
                disabled={anyActionInFlight}
                onClick={() => onOpenRejectModal(reserve.id)}
              >
                Reject
              </ActionButton>
            ) : (
              // Manager can still reject even without director ability
              <ActionButton
                variant="reject"
                isLoading={isRejectInFlight}
                disabled={anyActionInFlight}
                onClick={() => onOpenRejectModal(reserve.id)}
              >
                Reject
              </ActionButton>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Amount block ─────────────────────────────────────────────────────────────

interface AmountBlockProps {
  label: string;
  value: string;
  highlight?: boolean;
  positive?: boolean;
}

function AmountBlock({
  label,
  value,
  highlight = false,
  positive,
}: AmountBlockProps): React.ReactElement {
  return (
    <div
      className={[
        'rounded-lg px-4 py-3 ring-1 ring-inset',
        highlight
          ? 'bg-indigo-50 ring-indigo-200'
          : 'bg-gray-50 ring-gray-200',
      ].join(' ')}
    >
      <p className="text-xs font-medium text-gray-500">{label}</p>
      <p
        className={[
          'mt-1 font-mono text-lg font-bold',
          highlight
            ? 'text-indigo-700'
            : positive === true
            ? 'text-red-600'
            : positive === false
            ? 'text-green-600'
            : 'text-gray-800',
        ].join(' ')}
      >
        {value}
      </p>
    </div>
  );
}

// ─── Meta field ───────────────────────────────────────────────────────────────

interface MetaFieldProps {
  label: string;
  value: string;
  mono?: boolean;
}

function MetaField({ label, value, mono = false }: MetaFieldProps): React.ReactElement {
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wider text-gray-400">{label}</p>
      <p className={['mt-0.5 text-sm text-gray-700', mono ? 'font-mono' : ''].join(' ')}>
        {value}
      </p>
    </div>
  );
}

// ─── Action button ────────────────────────────────────────────────────────────

type ActionButtonVariant = 'approve' | 'director-approve' | 'reject';

interface ActionButtonProps {
  variant: ActionButtonVariant;
  isLoading: boolean;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}

const ACTION_BUTTON_STYLES: Record<ActionButtonVariant, string> = {
  approve:
    'bg-green-600 text-white hover:bg-green-700 focus:ring-green-500 disabled:bg-green-300',
  'director-approve':
    'bg-indigo-600 text-white hover:bg-indigo-700 focus:ring-indigo-500 disabled:bg-indigo-300',
  reject:
    'bg-white text-red-600 ring-1 ring-red-300 hover:bg-red-50 focus:ring-red-500 disabled:opacity-50',
};

function ActionButton({
  variant,
  isLoading,
  disabled,
  onClick,
  children,
}: ActionButtonProps): React.ReactElement {
  return (
    <button
      type="button"
      disabled={disabled || isLoading}
      onClick={onClick}
      className={[
        'inline-flex items-center gap-1.5 rounded-lg px-4 py-2 text-sm font-medium transition-colors',
        'focus:outline-none focus:ring-2 focus:ring-offset-2',
        'disabled:cursor-not-allowed',
        ACTION_BUTTON_STYLES[variant],
      ].join(' ')}
    >
      {isLoading ? (
        <SpinnerIcon className="h-4 w-4 animate-spin" aria-hidden />
      ) : null}
      {children}
    </button>
  );
}

// ─── Reject modal ─────────────────────────────────────────────────────────────

interface RejectModalProps {
  modal: RejectModalState;
  isSubmitting: boolean;
  onClose: () => void;
  onReasonChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
  onSubmit: () => void;
}

function RejectModal({
  modal,
  isSubmitting,
  onClose,
  onReasonChange,
  onSubmit,
}: RejectModalProps): React.ReactElement {
  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="reject-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-4"
    >
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-gray-900/50"
        aria-hidden="true"
        onClick={onClose}
      />

      {/* Panel */}
      <div className="relative z-10 w-full max-w-md rounded-xl bg-white shadow-xl ring-1 ring-gray-200">
        {/* Header */}
        <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
          <h2
            id="reject-modal-title"
            className="text-base font-semibold text-gray-900"
          >
            Reject Reserve Proposal
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors"
            aria-label="Close dialog"
          >
            <XIcon className="h-5 w-5" />
          </button>
        </div>

        {/* Body */}
        <div className="px-5 py-4 space-y-4">
          <p className="text-sm text-gray-600">
            Provide a reason for rejecting this reserve proposal. The reason will
            be recorded in the audit log and visible to the proposing adjuster.
          </p>

          <div>
            <label
              htmlFor="rejection-reason"
              className="block text-sm font-medium text-gray-700"
            >
              Rejection Reason
              <span className="ml-1 text-red-500" aria-hidden>
                *
              </span>
            </label>
            <textarea
              id="rejection-reason"
              rows={4}
              value={modal.reason}
              onChange={onReasonChange}
              disabled={isSubmitting}
              placeholder="Explain why this reserve proposal is being rejected (min. 10 characters)…"
              aria-describedby={
                modal.error !== null ? 'rejection-reason-error' : undefined
              }
              aria-invalid={modal.error !== null ? true : undefined}
              className={[
                'mt-1.5 block w-full resize-none rounded-lg border py-2 px-3 text-sm text-gray-900 placeholder-gray-400',
                'focus:outline-none focus:ring-2 focus:ring-red-500 focus:border-red-500',
                'disabled:cursor-not-allowed disabled:bg-gray-50',
                'transition-colors',
                modal.error !== null
                  ? 'border-red-400 bg-red-50'
                  : 'border-gray-300 bg-white',
              ].join(' ')}
            />
            {modal.error !== null && (
              <p
                id="rejection-reason-error"
                role="alert"
                className="mt-1.5 flex items-center gap-1 text-xs text-red-600"
              >
                <AlertIcon className="h-3 w-3 flex-shrink-0" aria-hidden />
                {modal.error}
              </p>
            )}
          </div>
        </div>

        {/* Footer */}
        <div className="flex items-center justify-end gap-3 border-t border-gray-100 px-5 py-4">
          <button
            type="button"
            onClick={onClose}
            disabled={isSubmitting}
            className="rounded-lg px-4 py-2 text-sm font-medium text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={onSubmit}
            disabled={isSubmitting || modal.reason.trim().length < 10}
            className="inline-flex items-center gap-2 rounded-lg bg-red-600 px-4 py-2 text-sm font-semibold text-white hover:bg-red-700 focus:outline-none focus:ring-2 focus:ring-red-500 focus:ring-offset-2 disabled:cursor-not-allowed disabled:bg-red-300 transition-colors"
          >
            {isSubmitting ? (
              <SpinnerIcon className="h-4 w-4 animate-spin" aria-hidden />
            ) : null}
            Confirm Rejection
          </button>
        </div>
      </div>
    </div>
  );
}

// ─── Skeleton loader ──────────────────────────────────────────────────────────

function ReserveListSkeleton(): React.ReactElement {
  return (
    <div className="space-y-4">
      {Array.from({ length: 3 }, (_, i) => (
        <div
          key={i}
          className="rounded-xl bg-white shadow-sm ring-1 ring-gray-200 overflow-hidden"
        >
          <div className="flex items-center justify-between border-b border-gray-100 px-5 py-4">
            <div className="flex gap-2">
              {[80, 60, 120].map((w) => (
                <div
                  key={w}
                  className="h-5 animate-pulse rounded-full bg-gray-100"
                  style={{ width: `${w}px` }}
                />
              ))}
            </div>
            <div className="h-7 w-24 animate-pulse rounded-lg bg-gray-100" />
          </div>
          <div className="px-5 py-4 space-y-4">
            <div className="grid grid-cols-3 gap-4">
              {[1, 2, 3].map((j) => (
                <div key={j} className="h-16 animate-pulse rounded-lg bg-gray-100" />
              ))}
            </div>
            <div className="grid grid-cols-4 gap-4">
              {[1, 2, 3, 4].map((j) => (
                <div key={j} className="h-8 animate-pulse rounded bg-gray-100" />
              ))}
            </div>
            <div className="h-16 animate-pulse rounded-lg bg-gray-100" />
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function ReserveEmptyState({ filter }: { filter: ApprovalFilter }): React.ReactElement {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-gray-300 bg-white px-6 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gray-100">
        <CheckCircleIcon className="h-7 w-7 text-gray-400" aria-hidden />
      </div>
      <div>
        <p className="text-sm font-semibold text-gray-700">
          {filter === 'pending' ? 'No pending approvals' : `No ${filter} reserves`}
        </p>
        <p className="mt-1 text-xs text-gray-400">
          {filter === 'pending'
            ? 'All reserve proposals have been reviewed. Nothing requires your attention right now.'
            : `There are no reserve proposals with a status of "${filter}" at this time.`}
        </p>
      </div>
    </div>
  );
}

// ─── SVG icons ────────────────────────────────────────────────────────────────

interface IconProps {
  className?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
}

function RefreshIcon({ className = 'h-4 w-4', ...rest }: IconProps): React.ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      <path
        fillRule="evenodd"
        d="M4 2a1 1 0 011 1v2.101a7.002 7.002 0 0111.601 2.566 1 1 0 11-1.885.666A5.002 5.002 0 005.999 7H9a1 1 0 010 2H4a1 1 0 01-1-1V3a1 1 0 011-1zm.008 9.057a1 1 0 011.276.61A5.002 5.002 0 0014.001 13H11a1 1 0 110-2h5a1 1 0 011 1v5a1 1 0 11-2 0v-2.101a7.002 7.002 0 01-11.601-2.566 1 1 0 01.61-1.276z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function AlertIcon({ className = 'h-4 w-4', ...rest }: IconProps): React.ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      <path
        fillRule="evenodd"
        d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-7 4a1 1 0 11-2 0 1 1 0 012 0zm-1-9a1 1 0 00-1 1v4a1 1 0 102 0V6a1 1 0 00-1-1z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function CheckCircleIcon({
  className = 'h-4 w-4',
  ...rest
}: IconProps): React.ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      <path
        fillRule="evenodd"
        d="M10 18a8 8 0 100-16 8 8 0 000 16zm3.707-9.293a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function ShieldCheckIcon({
  className = 'h-4 w-4',
  ...rest
}: IconProps): React.ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      <path
        fillRule="evenodd"
        d="M10 1.944A11.954 11.954 0 012.166 5C2.056 5.649 2 6.319 2 7c0 5.225 3.34 9.67 8 11.317C14.66 16.67 18 12.225 18 7c0-.682-.057-1.35-.166-2.001A11.954 11.954 0 0110 1.944zM14.707 7.707a1 1 0 00-1.414-1.414L9 10.586 7.707 9.293a1 1 0 00-1.414 1.414l2 2a1 1 0 001.414 0l4-4z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function ExclamationIcon({
  className = 'h-4 w-4',
  ...rest
}: IconProps): React.ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      <path
        fillRule="evenodd"
        d="M8.257 3.099c.765-1.36 2.722-1.36 3.486 0l5.58 9.92c.75 1.334-.213 2.98-1.742 2.98H4.42c-1.53 0-2.493-1.646-1.743-2.98l5.58-9.92zM11 13a1 1 0 11-2 0 1 1 0 012 0zm-1-8a1 1 0 00-1 1v3a1 1 0 002 0V6a1 1 0 00-1-1z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function XIcon({ className = 'h-5 w-5', ...rest }: IconProps): React.ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 20 20"
      fill="currentColor"
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      <path
        fillRule="evenodd"
        d="M4.293 4.293a1 1 0 011.414 0L10 8.586l4.293-4.293a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 01-1.414 1.414L10 11.414l-4.293 4.293a1 1 0 01-1.414-1.414L8.586 10 4.293 5.707a1 1 0 010-1.414z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function SpinnerIcon({ className = 'h-4 w-4', ...rest }: IconProps): React.ReactElement {
  return (
    <svg
      className={className}
      viewBox="0 0 24 24"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
      {...rest}
    >
      <circle
        className="opacity-25"
        cx="12"
        cy="12"
        r="10"
        stroke="currentColor"
        strokeWidth="4"
      />
      <path
        className="opacity-75"
        fill="currentColor"
        d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"
      />
    </svg>
  );
}