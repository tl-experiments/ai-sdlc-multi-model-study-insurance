/**
 * ReserveApprovals.tsx
 * Manager workflow for reviewing and approving reserve proposals.
 * Displays pending reserves, approval thresholds, and director-level approval requirements.
 * Allows managers to approve, reject, or escalate reserve changes.
 */

import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Layout, PageHeader, Card, Badge, Section } from '../components/Layout';
import { formatYen } from '../lib/format-yen';

/**
 * Reserve type matching the backend Reserve model.
 */
interface Reserve {
  id: string;
  claim_id: string;
  category: 'loss_paid' | 'loss_unpaid' | 'alae' | 'ulae';
  proposed_yen: string;
  prior_yen?: string;
  justification: string;
  proposed_by_id: string;
  proposed_at: string;
  approval_status: 'pending' | 'approved' | 'rejected';
  approved_by_id?: string;
  approved_at?: string;
  director_approved_by_id?: string;
  director_approved_at?: string;
  reason_for_rejection?: string;
}

/**
 * Claim summary for reserve context.
 */
interface ClaimSummary {
  id: string;
  policy_number: string;
  incident_type: string;
  loss_date: string;
  severity_initial: 'simple' | 'complex' | 'catastrophic';
}

/**
 * Reserve with claim context.
 */
interface ReserveWithClaim extends Reserve {
  claim: ClaimSummary;
}

/**
 * Metadata for reserve categories.
 */
const RESERVE_CATEGORY_CONFIG: Record<
  'loss_paid' | 'loss_unpaid' | 'alae' | 'ulae',
  { label: string; description: string }
> = {
  loss_paid: { label: 'Loss Paid', description: 'Amounts already paid out' },
  loss_unpaid: {
    label: 'Loss Unpaid',
    description: 'Estimated future loss payments',
  },
  alae: {
    label: 'ALAE',
    description: 'Allocated Loss Adjustment Expense',
  },
  ulae: {
    label: 'ULAE',
    description: 'Unallocated Loss Adjustment Expense',
  },
};

/**
 * Metadata for incident types.
 */
const INCIDENT_TYPE_CONFIG: Record<string, { label: string }> = {
  auto_collision: { label: 'Auto Collision' },
  auto_property_damage: { label: 'Auto Property Damage' },
  fire_residential: { label: 'Fire - Residential' },
  fire_commercial: { label: 'Fire - Commercial' },
  marine_cargo: { label: 'Marine Cargo' },
  liability_premises: { label: 'Liability - Premises' },
  personal_accident: { label: 'Personal Accident' },
};

/**
 * Metadata for claim severity.
 */
const SEVERITY_CONFIG: Record<
  'simple' | 'complex' | 'catastrophic',
  { label: string; color: string; icon: string }
> = {
  simple: { label: 'Simple', color: 'bg-green-100 text-green-800', icon: '✓' },
  complex: {
    label: 'Complex',
    color: 'bg-yellow-100 text-yellow-800',
    icon: '⚠',
  },
  catastrophic: {
    label: 'Catastrophic',
    color: 'bg-red-100 text-red-800',
    icon: '🚨',
  },
};

/**
 * Approval threshold constants (in yen).
 */
const APPROVAL_THRESHOLDS = {
  MANAGER_ONLY: 1_000_000, // ¥1M
  DIRECTOR_REQUIRED: 10_000_000, // ¥10M
};

/**
 * Props for the ReserveApprovalCard component.
 */
interface ReserveApprovalCardProps {
  reserve: ReserveWithClaim;
  onApprove: (reserveId: string) => Promise<void>;
  onDirectorApprove: (reserveId: string) => Promise<void>;
  onReject: (reserveId: string, reason: string) => Promise<void>;
  isDirector: boolean;
  isProcessing: boolean;
}

/**
 * ReserveApprovalCard component — displays a single reserve for approval.
 */
const ReserveApprovalCard: React.FC<ReserveApprovalCardProps> = ({
  reserve,
  onApprove,
  onDirectorApprove,
  onReject,
  isDirector,
  isProcessing,
}) => {
  const [showRejectForm, setShowRejectForm] = useState(false);
  const [rejectReason, setRejectReason] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);

  const proposedAmount = parseInt(reserve.proposed_yen, 10);
  const priorAmount = reserve.prior_yen ? parseInt(reserve.prior_yen, 10) : 0;
  const change = proposedAmount - priorAmount;
  const changePercent =
    priorAmount > 0 ? ((change / priorAmount) * 100).toFixed(1) : 'N/A';

  const requiresDirector = proposedAmount > APPROVAL_THRESHOLDS.DIRECTOR_REQUIRED;
  const requiresManagerApproval =
    proposedAmount > APPROVAL_THRESHOLDS.MANAGER_ONLY;

  const severityConfig = SEVERITY_CONFIG[reserve.claim.severity_initial];
  const incidentConfig = INCIDENT_TYPE_CONFIG[reserve.claim.incident_type];

  const proposedDate = new Date(reserve.proposed_at).toLocaleDateString(
    'en-US',
    {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }
  );

  const handleReject = async () => {
    if (!rejectReason.trim()) return;

    setIsSubmitting(true);
    try {
      await onReject(reserve.id, rejectReason);
      setRejectReason('');
      setShowRejectForm(false);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleApprove = async () => {
    setIsSubmitting(true);
    try {
      await onApprove(reserve.id);
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleDirectorApprove = async () => {
    setIsSubmitting(true);
    try {
      await onDirectorApprove(reserve.id);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="p-6 bg-white rounded-lg border border-gray-200 hover:border-gray-300 transition-colors">
      {/* Header */}
      <div className="flex items-start justify-between mb-4">
        <div className="flex-1">
          <div className="flex items-center gap-2 mb-2">
            <h3 className="text-lg font-semibold text-gray-900">
              {RESERVE_CATEGORY_CONFIG[reserve.category].label}
            </h3>
            <Badge variant="info">
              {reserve.claim.policy_number}
            </Badge>
          </div>
          <p className="text-sm text-gray-600">
            Claim {reserve.claim.id.substring(0, 8)} •{' '}
            {incidentConfig?.label || reserve.claim.incident_type}
          </p>
        </div>
        <div className="text-right">
          <p className="text-2xl font-bold text-gray-900">
            {formatYen(proposedAmount)}
          </p>
          {priorAmount > 0 && (
            <p
              className={`text-sm font-medium ${
                change > 0 ? 'text-orange-600' : 'text-green-600'
              }`}
            >
              {change > 0 ? '+' : ''}{formatYen(change)} ({changePercent}%)
            </p>
          )}
        </div>
      </div>

      {/* Claim context */}
      <div className="mb-4 p-3 bg-gray-50 rounded-lg border border-gray-200">
        <div className="grid grid-cols-2 gap-4 text-sm">
          <div>
            <p className="text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">
              Loss Date
            </p>
            <p className="text-gray-900">
              {new Date(reserve.claim.loss_date).toLocaleDateString('en-US', {
                year: 'numeric',
                month: 'short',
                day: 'numeric',
              })}
            </p>
          </div>
          <div>
            <p className="text-xs font-semibold text-gray-600 uppercase tracking-wider mb-1">
              Severity
            </p>
            <Badge variant="warning">
              {severityConfig.icon} {severityConfig.label}
            </Badge>
          </div>
        </div>
      </div>

      {/* Justification */}
      <div className="mb-4">
        <p className="text-xs font-semibold text-gray-600 uppercase tracking-wider mb-2">
          Justification
        </p>
        <p className="text-sm text-gray-700">{reserve.justification}</p>
      </div>

      {/* Approval threshold indicators */}
      <div className="mb-4 space-y-2">
        {requiresManagerApproval && (
          <div className="p-2 bg-yellow-50 border border-yellow-200 rounded">
            <p className="text-xs font-medium text-yellow-700">
              ⚠️ Exceeds ¥1M threshold — manager approval required
            </p>
          </div>
        )}
        {requiresDirector && (
          <div className="p-2 bg-orange-50 border border-orange-200 rounded">
            <p className="text-xs font-medium text-orange-700">
              🔴 Exceeds ¥10M threshold — claims director approval required
            </p>
          </div>
        )}
      </div>

      {/* Metadata */}
      <div className="mb-4 pt-4 border-t border-gray-200 text-xs text-gray-600">
        <p>Proposed {proposedDate}</p>
        <p>Category: {RESERVE_CATEGORY_CONFIG[reserve.category].description}</p>
      </div>

      {/* Action buttons */}
      <div className="flex gap-2">
        {reserve.approval_status === 'pending' ? (
          <>
            {!requiresDirector ? (
              <button
                onClick={handleApprove}
                disabled={isSubmitting || isProcessing}
                className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
              >
                {isSubmitting ? '⏳ Approving…' : '✅ Approve'}
              </button>
            ) : isDirector ? (
              <button
                onClick={handleDirectorApprove}
                disabled={isSubmitting || isProcessing}
                className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg text-sm font-medium hover:bg-green-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
              >
                {isSubmitting ? '⏳ Director Approving…' : '✅ Director Approve'}
              </button>
            ) : (
              <div className="flex-1 px-4 py-2 bg-gray-100 text-gray-600 rounded-lg text-sm font-medium text-center">
                Awaiting Director
              </div>
            )}

            {!showRejectForm ? (
              <button
                onClick={() => setShowRejectForm(true)}
                disabled={isSubmitting || isProcessing}
                className="flex-1 px-4 py-2 bg-red-100 text-red-700 rounded-lg text-sm font-medium hover:bg-red-200 disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed transition-colors"
              >
                ❌ Reject
              </button>
            ) : (
              <div className="flex-1 space-y-2">
                <textarea
                  value={rejectReason}
                  onChange={(e) => setRejectReason(e.target.value)}
                  placeholder="Reason for rejection…"
                  disabled={isSubmitting}
                  className="w-full px-3 py-2 border border-red-300 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-red-500 disabled:bg-gray-100"
                  rows={2}
                />
                <div className="flex gap-2">
                  <button
                    onClick={handleReject}
                    disabled={!rejectReason.trim() || isSubmitting}
                    className="flex-1 px-3 py-1 bg-red-600 text-white rounded text-xs font-medium hover:bg-red-700 disabled:bg-gray-400 disabled:cursor-not-allowed transition-colors"
                  >
                    {isSubmitting ? '⏳' : '✓'} Confirm
                  </button>
                  <button
                    onClick={() => {
                      setShowRejectForm(false);
                      setRejectReason('');
                    }}
                    disabled={isSubmitting}
                    className="flex-1 px-3 py-1 bg-gray-300 text-gray-900 rounded text-xs font-medium hover:bg-gray-400 disabled:bg-gray-200 transition-colors"
                  >
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </>
        ) : reserve.approval_status === 'approved' ? (
          <div className="w-full px-4 py-2 bg-green-50 text-green-700 rounded-lg text-sm font-medium text-center border border-green-200">
            ✅ Approved
            {reserve.approved_at && (
              <p className="text-xs text-green-600 mt-1">
                {new Date(reserve.approved_at).toLocaleDateString('en-US', {
                  year: 'numeric',
                  month: 'short',
                  day: 'numeric',
                })}
              </p>
            )}
          </div>
        ) : (
          <div className="w-full px-4 py-2 bg-red-50 text-red-700 rounded-lg text-sm font-medium text-center border border-red-200">
            ❌ Rejected
            {reserve.reason_for_rejection && (
              <p className="text-xs text-red-600 mt-1">
                {reserve.reason_for_rejection}
              </p>
            )}
          </div>
        )}
      </div>
    </div>
  );
};

/**
 * Filter state for reserve approvals.
 */
interface FilterState {
  status: 'pending' | 'approved' | 'rejected' | 'all';
  category: 'loss_paid' | 'loss_unpaid' | 'alae' | 'ulae' | 'all';
  minAmount: string;
  maxAmount: string;
}

/**
 * ReserveApprovals component — manager workflow for reviewing and approving reserves.
 * Displays pending reserves with approval thresholds and director-level requirements.
 * @returns Rendered reserve approvals page
 */
export const ReserveApprovals: React.FC = () => {
  const navigate = useNavigate();
  const { currentUser: user } = useAuth();

  const [reserves, setReserves] = useState<ReserveWithClaim[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [isProcessing, setIsProcessing] = useState(false);

  const [filters, setFilters] = useState<FilterState>({
    status: 'pending',
    category: 'all',
    minAmount: '',
    maxAmount: '',
  });

  const isDirector = user?.is_claims_director ?? false;

  /**
   * Fetch reserves from the API.
   */
  useEffect(() => {
    const fetchReserves = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const token = localStorage.getItem('access_token');
        if (!token) {
          throw new Error('No authentication token found');
        }

        const queryParams = new URLSearchParams();
        if (filters.status !== 'all') {
          queryParams.append('status', filters.status);
        }
        if (filters.category !== 'all') {
          queryParams.append('category', filters.category);
        }
        if (filters.minAmount) {
          queryParams.append('minAmount', filters.minAmount);
        }
        if (filters.maxAmount) {
          queryParams.append('maxAmount', filters.maxAmount);
        }

        const response = await fetch(
          `/api/reserves?${queryParams.toString()}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
          }
        );

        if (!response.ok) {
          throw new Error(`Failed to fetch reserves: ${response.statusText}`);
        }

        const data = await response.json();
        setReserves(Array.isArray(data) ? data : data.data || []);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Failed to load reserves'
        );
      } finally {
        setIsLoading(false);
      }
    };

    fetchReserves();
  }, [filters]);

  /**
   * Handle reserve approval.
   */
  const handleApprove = async (reserveId: string) => {
    setIsProcessing(true);
    try {
      const token = localStorage.getItem('access_token');
      if (!token) throw new Error('No authentication token');

      const response = await fetch(`/api/reserves/${reserveId}/approve`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
      });

      if (!response.ok) {
        throw new Error('Failed to approve reserve');
      }

      // Refresh reserves
      setReserves(
        reserves.map((r) =>
          r.id === reserveId
            ? { ...r, approval_status: 'approved' as const }
            : r
        )
      );
    } catch (err) {
      console.error('Error approving reserve:', err);
      setError(
        err instanceof Error ? err.message : 'Failed to approve reserve'
      );
    } finally {
      setIsProcessing(false);
    }
  };

  /**
   * Handle director-level reserve approval.
   */
  const handleDirectorApprove = async (reserveId: string) => {
    setIsProcessing(true);
    try {
      const token = localStorage.getItem('access_token');
      if (!token) throw new Error('No authentication token');

      const response = await fetch(
        `/api/reserves/${reserveId}/director-approve`,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
        }
      );

      if (!response.ok) {
        throw new Error('Failed to approve reserve');
      }

      // Refresh reserves
      setReserves(
        reserves.map((r) =>
          r.id === reserveId
            ? { ...r, approval_status: 'approved' as const }
            : r
        )
      );
    } catch (err) {
      console.error('Error approving reserve:', err);
      setError(
        err instanceof Error ? err.message : 'Failed to approve reserve'
      );
    } finally {
      setIsProcessing(false);
    }
  };

  /**
   * Handle reserve rejection.
   */
  const handleReject = async (reserveId: string, reason: string) => {
    setIsProcessing(true);
    try {
      const token = localStorage.getItem('access_token');
      if (!token) throw new Error('No authentication token');

      const response = await fetch(`/api/reserves/${reserveId}/reject`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ reason_for_rejection: reason }),
      });

      if (!response.ok) {
        throw new Error('Failed to reject reserve');
      }

      // Refresh reserves
      setReserves(
        reserves.map((r) =>
          r.id === reserveId
            ? {
                ...r,
                approval_status: 'rejected' as const,
                reason_for_rejection: reason,
              }
            : r
        )
      );
    } catch (err) {
      console.error('Error rejecting reserve:', err);
      setError(
        err instanceof Error ? err.message : 'Failed to reject reserve'
      );
    } finally {
      setIsProcessing(false);
    }
  };

  /**
   * Filter reserves based on current filter state.
   */
  const filteredReserves = reserves.filter((reserve) => {
    const amount = parseInt(reserve.proposed_yen, 10);
    if (filters.minAmount && amount < parseInt(filters.minAmount, 10)) {
      return false;
    }
    if (filters.maxAmount && amount > parseInt(filters.maxAmount, 10)) {
      return false;
    }
    return true;
  });

  /**
   * Calculate statistics.
   */
  const stats = {
    pending: reserves.filter((r) => r.approval_status === 'pending').length,
    approved: reserves.filter((r) => r.approval_status === 'approved').length,
    rejected: reserves.filter((r) => r.approval_status === 'rejected').length,
    totalPending: reserves
      .filter((r) => r.approval_status === 'pending')
      .reduce((sum, r) => sum + parseInt(r.proposed_yen, 10), 0),
    requiresDirector: reserves.filter(
      (r) =>
        r.approval_status === 'pending' &&
        parseInt(r.proposed_yen, 10) > APPROVAL_THRESHOLDS.DIRECTOR_REQUIRED
    ).length,
  };

  return (
    <Layout>
      <div className="space-y-6">
        {/* Page header */}
        <PageHeader
          title="Reserve Approvals"
          description="Review and approve reserve proposals"
          icon="💰"
          action={
            <button
              onClick={() => navigate('/claims')}
              className="px-4 py-2 bg-gray-300 text-gray-900 rounded-lg text-sm font-medium hover:bg-gray-400 transition-colors"
            >
              ← Back to Claims
            </button>
          }
        />

        {/* Statistics cards */}
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          <Card className="bg-gradient-to-br from-yellow-50 to-yellow-100 border-yellow-200">
            <div>
              <p className="text-xs font-semibold text-yellow-700 uppercase tracking-wider mb-1">
                Pending
              </p>
              <p className="text-3xl font-bold text-yellow-900">{stats.pending}</p>
              <p className="text-xs text-yellow-700 mt-2">
                {formatYen(stats.totalPending)}
              </p>
            </div>
          </Card>

          <Card className="bg-gradient-to-br from-green-50 to-green-100 border-green-200">
            <div>
              <p className="text-xs font-semibold text-green-700 uppercase tracking-wider mb-1">
                Approved
              </p>
              <p className="text-3xl font-bold text-green-900">{stats.approved}</p>
            </div>
          </Card>

          <Card className="bg-gradient-to-br from-red-50 to-red-100 border-red-200">
            <div>
              <p className="text-xs font-semibold text-red-700 uppercase tracking-wider mb-1">
                Rejected
              </p>
              <p className="text-3xl font-bold text-red-900">{stats.rejected}</p>
            </div>
          </Card>

          <Card className="bg-gradient-to-br from-orange-50 to-orange-100 border-orange-200">
            <div>
              <p className="text-xs font-semibold text-orange-700 uppercase tracking-wider mb-1">
                Requires Director
              </p>
              <p className="text-3xl font-bold text-orange-900">
                {stats.requiresDirector}
              </p>
            </div>
          </Card>
        </div>

        {/* Role indicator */}
        {isDirector && (
          <div className="p-4 bg-blue-50 border border-blue-200 rounded-lg">
            <p className="text-sm text-blue-700 font-medium">
              👤 You are a claims director — you can approve reserves exceeding
              ¥10M
            </p>
          </div>
        )}

        {/* Filters section */}
        <Card title="Filters" className="bg-gray-50">
          <div className="space-y-4">
            {/* Status filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Status
              </label>
              <div className="flex flex-wrap gap-2">
                {[
                  { value: 'all', label: 'All' },
                  { value: 'pending', label: 'Pending' },
                  { value: 'approved', label: 'Approved' },
                  { value: 'rejected', label: 'Rejected' },
                ].map((option) => (
                  <button
                    key={option.value}
                    onClick={() =>
                      setFilters({
                        ...filters,
                        status: option.value as any,
                      })
                    }
                    className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                      filters.status === option.value
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Category filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Category
              </label>
              <div className="flex flex-wrap gap-2">
                {[
                  { value: 'all', label: 'All' },
                  { value: 'loss_paid', label: 'Loss Paid' },
                  { value: 'loss_unpaid', label: 'Loss Unpaid' },
                  { value: 'alae', label: 'ALAE' },
                  { value: 'ulae', label: 'ULAE' },
                ].map((option) => (
                  <button
                    key={option.value}
                    onClick={() =>
                      setFilters({
                        ...filters,
                        category: option.value as any,
                      })
                    }
                    className={`px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
                      filters.category === option.value
                        ? 'bg-blue-600 text-white'
                        : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
                    }`}
                  >
                    {option.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Amount range filter */}
            <div className="grid grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Min Amount (¥)
                </label>
                <input
                  type="number"
                  value={filters.minAmount}
                  onChange={(e) =>
                    setFilters({ ...filters, minAmount: e.target.value })
                  }
                  placeholder="0"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Max Amount (¥)
                </label>
                <input
                  type="number"
                  value={filters.maxAmount}
                  onChange={(e) =>
                    setFilters({ ...filters, maxAmount: e.target.value })
                  }
                  placeholder="∞"
                  className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>
          </div>
        </Card>

        {/* Error message */}
        {error && (
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-sm text-red-700 font-medium">⚠️ {error}</p>
          </div>
        )}

        {/* Reserves list */}
        <div>
          {isLoading ? (
            <Card>
              <div className="text-center py-12">
                <p className="text-gray-500">Loading reserves…</p>
              </div>
            </Card>
          ) : filteredReserves.length === 0 ? (
            <Card>
              <div className="text-center py-12">
                <p className="text-gray-500 text-sm">No reserves found</p>
              </div>
            </Card>
          ) : (
            <div className="space-y-4">
              {filteredReserves.map((reserve) => (
                <ReserveApprovalCard
                  key={reserve.id}
                  reserve={reserve}
                  onApprove={handleApprove}
                  onDirectorApprove={handleDirectorApprove}
                  onReject={handleReject}
                  isDirector={isDirector}
                  isProcessing={isProcessing}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </Layout>
  );
};

export default ReserveApprovals;