/**
 * ClaimQueue.tsx
 * Displays a filterable list of claims for the adjuster workbench.
 * Allows filtering by status, severity, channel, and assignee.
 * Provides quick access to claim details and role-based actions.
 */

import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Layout, PageHeader, Card, Badge, Section } from '../components/Layout';
import { formatYen } from '../lib/format-yen';

/**
 * Claim type matching the backend Claim model.
 */
interface Claim {
  id: string;
  policy_number: string;
  loss_date: string;
  loss_location_prefecture: string;
  reported_by_channel: 'agent' | 'mobile' | 'broker' | 'email';
  reporter_name: string;
  incident_type: string;
  severity_initial: 'simple' | 'complex' | 'catastrophic';
  status: ClaimStatus;
  assigned_adjuster_id: string | null;
  created_at: string;
  injury_reported: boolean;
  third_party_involved: boolean;
}

type ClaimStatus =
  | 'intake'
  | 'under_investigation'
  | 'awaiting_reserve_approval'
  | 'settlement_offered'
  | 'closed_paid'
  | 'closed_denied'
  | 'reopened';

type IncidentType =
  | 'auto_collision'
  | 'auto_property_damage'
  | 'fire_residential'
  | 'fire_commercial'
  | 'marine_cargo'
  | 'liability_premises'
  | 'personal_accident';

type IntakeChannel = 'agent' | 'mobile' | 'broker' | 'email';

/**
 * Filter state structure.
 */
interface FilterState {
  status: ClaimStatus | 'all';
  severity: 'simple' | 'complex' | 'catastrophic' | 'all';
  channel: IntakeChannel | 'all';
  assignee: 'assigned' | 'unassigned' | 'all';
  searchQuery: string;
}

/**
 * Metadata for claim statuses.
 */
const STATUS_CONFIG: Record<
  ClaimStatus,
  { label: string; color: string; icon: string }
> = {
  intake: { label: 'Intake', color: 'bg-blue-100 text-blue-800', icon: '📥' },
  under_investigation: {
    label: 'Under Investigation',
    color: 'bg-yellow-100 text-yellow-800',
    icon: '🔍',
  },
  awaiting_reserve_approval: {
    label: 'Awaiting Reserve Approval',
    color: 'bg-orange-100 text-orange-800',
    icon: '⏳',
  },
  settlement_offered: {
    label: 'Settlement Offered',
    color: 'bg-purple-100 text-purple-800',
    icon: '💬',
  },
  closed_paid: {
    label: 'Closed - Paid',
    color: 'bg-green-100 text-green-800',
    icon: '✅',
  },
  closed_denied: {
    label: 'Closed - Denied',
    color: 'bg-red-100 text-red-800',
    icon: '❌',
  },
  reopened: {
    label: 'Reopened',
    color: 'bg-pink-100 text-pink-800',
    icon: '🔄',
  },
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
 * Metadata for intake channels.
 */
const CHANNEL_CONFIG: Record<IntakeChannel, { label: string; icon: string }> =
  {
    agent: { label: 'Agent', icon: '☎️' },
    mobile: { label: 'Mobile App', icon: '📱' },
    broker: { label: 'Broker', icon: '🤝' },
    email: { label: 'Email', icon: '📧' },
  };

/**
 * Metadata for incident types.
 */
const INCIDENT_TYPE_CONFIG: Record<IncidentType, { label: string }> = {
  auto_collision: { label: 'Auto Collision' },
  auto_property_damage: { label: 'Auto Property Damage' },
  fire_residential: { label: 'Fire - Residential' },
  fire_commercial: { label: 'Fire - Commercial' },
  marine_cargo: { label: 'Marine Cargo' },
  liability_premises: { label: 'Liability - Premises' },
  personal_accident: { label: 'Personal Accident' },
};

/**
 * Props for the ClaimRow component.
 */
interface ClaimRowProps {
  claim: Claim;
  onClick: (claimId: string) => void;
}

/**
 * ClaimRow component — displays a single claim in the queue.
 */
const ClaimRow: React.FC<ClaimRowProps> = ({ claim, onClick }) => {
  const statusConfig = STATUS_CONFIG[claim.status];
  const severityConfig = SEVERITY_CONFIG[claim.severity_initial];
  const channelConfig = CHANNEL_CONFIG[claim.reported_by_channel];
  const incidentConfig = INCIDENT_TYPE_CONFIG[claim.incident_type as IncidentType];

  const lossDate = new Date(claim.loss_date).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  const createdDate = new Date(claim.created_at).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });

  const daysOld = Math.floor(
    (Date.now() - new Date(claim.created_at).getTime()) / (1000 * 60 * 60 * 24)
  );

  return (
    <tr
      onClick={() => onClick(claim.id)}
      className="border-b border-gray-200 hover:bg-blue-50 cursor-pointer transition-colors"
    >
      {/* Claim ID */}
      <td className="px-6 py-4 whitespace-nowrap">
        <div className="text-sm font-mono text-blue-600 hover:underline">
          {claim.id.substring(0, 8)}
        </div>
      </td>

      {/* Policy Number */}
      <td className="px-6 py-4 whitespace-nowrap">
        <div className="text-sm font-medium text-gray-900">
          {claim.policy_number}
        </div>
      </td>

      {/* Incident Type */}
      <td className="px-6 py-4 whitespace-nowrap">
        <div className="text-sm text-gray-700">
          {incidentConfig?.label || claim.incident_type}
        </div>
      </td>

      {/* Loss Date */}
      <td className="px-6 py-4 whitespace-nowrap">
        <div className="text-sm text-gray-600">{lossDate}</div>
      </td>

      {/* Prefecture */}
      <td className="px-6 py-4 whitespace-nowrap">
        <div className="text-sm text-gray-600">
          {claim.loss_location_prefecture}
        </div>
      </td>

      {/* Channel */}
      <td className="px-6 py-4 whitespace-nowrap">
        <div className="flex items-center gap-1">
          <span className="text-lg">{channelConfig.icon}</span>
          <span className="text-xs text-gray-600">{channelConfig.label}</span>
        </div>
      </td>

      {/* Severity */}
      <td className="px-6 py-4 whitespace-nowrap">
        <Badge variant="warning">
          {severityConfig.icon} {severityConfig.label}
        </Badge>
      </td>

      {/* Status */}
      <td className="px-6 py-4 whitespace-nowrap">
        <Badge variant="info">
          {statusConfig.icon} {statusConfig.label}
        </Badge>
      </td>

      {/* Assigned Adjuster */}
      <td className="px-6 py-4 whitespace-nowrap">
        {claim.assigned_adjuster_id ? (
          <div className="text-xs text-gray-600">Assigned</div>
        ) : (
          <div className="text-xs text-orange-600 font-medium">Unassigned</div>
        )}
      </td>

      {/* Age */}
      <td className="px-6 py-4 whitespace-nowrap">
        <div className="text-xs text-gray-500">{daysOld}d</div>
      </td>

      {/* Flags */}
      <td className="px-6 py-4 whitespace-nowrap">
        <div className="flex gap-1">
          {claim.injury_reported && (
            <span title="Injury reported" className="text-lg">
              🚑
            </span>
          )}
          {claim.third_party_involved && (
            <span title="Third party involved" className="text-lg">
              👥
            </span>
          )}
        </div>
      </td>
    </tr>
  );
};

/**
 * FilterChip component — displays a filter option that can be toggled.
 */
interface FilterChipProps {
  label: string;
  icon?: string;
  isActive: boolean;
  onClick: () => void;
}

const FilterChip: React.FC<FilterChipProps> = ({
  label,
  icon,
  isActive,
  onClick,
}) => {
  return (
    <button
      onClick={onClick}
      className={`inline-flex items-center gap-2 px-3 py-1.5 rounded-full text-sm font-medium transition-colors ${
        isActive
          ? 'bg-blue-600 text-white'
          : 'bg-gray-200 text-gray-700 hover:bg-gray-300'
      }`}
    >
      {icon && <span>{icon}</span>}
      {label}
    </button>
  );
};

/**
 * ClaimQueue component — displays a filterable list of claims.
 * Allows filtering by status, severity, channel, and assignee.
 * Provides quick access to claim details.
 * @returns Rendered claim queue page
 */
export const ClaimQueue: React.FC = () => {
  const navigate = useNavigate();
  const { currentUser: user } = useAuth();

  const [claims, setClaims] = useState<Claim[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [filters, setFilters] = useState<FilterState>({
    status: 'all',
    severity: 'all',
    channel: 'all',
    assignee: 'all',
    searchQuery: '',
  });

  /**
   * Fetch claims from the API.
   */
  useEffect(() => {
    const fetchClaims = async () => {
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
        if (filters.severity !== 'all') {
          queryParams.append('severity', filters.severity);
        }
        if (filters.channel !== 'all') {
          queryParams.append('channel', filters.channel);
        }
        if (filters.assignee === 'assigned') {
          queryParams.append('assigned', 'true');
        } else if (filters.assignee === 'unassigned') {
          queryParams.append('assigned', 'false');
        }
        if (filters.searchQuery) {
          queryParams.append('search', filters.searchQuery);
        }

        const response = await fetch(
          `/api/claims?${queryParams.toString()}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
          }
        );

        if (!response.ok) {
          throw new Error(`Failed to fetch claims: ${response.statusText}`);
        }

        const data = await response.json();
        setClaims(Array.isArray(data) ? data : data.data || []);
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Failed to load claims');
      } finally {
        setIsLoading(false);
      }
    };

    fetchClaims();
  }, [filters]);

  /**
   * Handle filter changes.
   */
  const handleFilterChange = (
    key: keyof FilterState,
    value: string | boolean
  ) => {
    setFilters((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  /**
   * Reset all filters.
   */
  const handleResetFilters = () => {
    setFilters({
      status: 'all',
      severity: 'all',
      channel: 'all',
      assignee: 'all',
      searchQuery: '',
    });
  };

  /**
   * Handle claim row click — navigate to claim detail.
   */
  const handleClaimClick = (claimId: string) => {
    navigate(`/claims/${claimId}`);
  };

  /**
   * Filter claims based on current filter state.
   */
  const filteredClaims = claims.filter((claim) => {
    if (filters.searchQuery) {
      const query = filters.searchQuery.toLowerCase();
      const matchesSearch =
        claim.id.toLowerCase().includes(query) ||
        claim.policy_number.toLowerCase().includes(query) ||
        claim.reporter_name.toLowerCase().includes(query);
      if (!matchesSearch) return false;
    }
    return true;
  });

  return (
    <Layout>
      <div className="space-y-6">
        {/* Page header */}
        <PageHeader
          title="Claims Queue"
          description="View and manage all claims in the system"
          icon="📋"
          action={
            <button
              onClick={() => navigate('/claims/new')}
              className="px-4 py-2 bg-blue-600 text-white rounded-lg text-sm font-medium hover:bg-blue-700 transition-colors"
            >
              ➕ New Claim
            </button>
          }
        />

        {/* Filters section */}
        <Card title="Filters" className="bg-gray-50">
          <div className="space-y-4">
            {/* Search */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Search
              </label>
              <input
                type="text"
                placeholder="Search by claim ID, policy number, or reporter name…"
                value={filters.searchQuery}
                onChange={(e) =>
                  handleFilterChange('searchQuery', e.target.value)
                }
                className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>

            {/* Status filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Status
              </label>
              <div className="flex flex-wrap gap-2">
                <FilterChip
                  label="All"
                  isActive={filters.status === 'all'}
                  onClick={() => handleFilterChange('status', 'all')}
                />
                {Object.entries(STATUS_CONFIG).map(([status, config]) => (
                  <FilterChip
                    key={status}
                    label={config.label}
                    icon={config.icon}
                    isActive={filters.status === status}
                    onClick={() => handleFilterChange('status', status)}
                  />
                ))}
              </div>
            </div>

            {/* Severity filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Severity
              </label>
              <div className="flex flex-wrap gap-2">
                <FilterChip
                  label="All"
                  isActive={filters.severity === 'all'}
                  onClick={() => handleFilterChange('severity', 'all')}
                />
                {Object.entries(SEVERITY_CONFIG).map(([severity, config]) => (
                  <FilterChip
                    key={severity}
                    label={config.label}
                    icon={config.icon}
                    isActive={filters.severity === severity}
                    onClick={() => handleFilterChange('severity', severity)}
                  />
                ))}
              </div>
            </div>

            {/* Channel filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Channel
              </label>
              <div className="flex flex-wrap gap-2">
                <FilterChip
                  label="All"
                  isActive={filters.channel === 'all'}
                  onClick={() => handleFilterChange('channel', 'all')}
                />
                {Object.entries(CHANNEL_CONFIG).map(([channel, config]) => (
                  <FilterChip
                    key={channel}
                    label={config.label}
                    icon={config.icon}
                    isActive={filters.channel === channel}
                    onClick={() => handleFilterChange('channel', channel)}
                  />
                ))}
              </div>
            </div>

            {/* Assignee filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Assignment
              </label>
              <div className="flex flex-wrap gap-2">
                <FilterChip
                  label="All"
                  isActive={filters.assignee === 'all'}
                  onClick={() => handleFilterChange('assignee', 'all')}
                />
                <FilterChip
                  label="Assigned"
                  icon="✓"
                  isActive={filters.assignee === 'assigned'}
                  onClick={() => handleFilterChange('assignee', 'assigned')}
                />
                <FilterChip
                  label="Unassigned"
                  icon="⚠"
                  isActive={filters.assignee === 'unassigned'}
                  onClick={() => handleFilterChange('assignee', 'unassigned')}
                />
              </div>
            </div>

            {/* Reset button */}
            <div className="flex justify-end">
              <button
                onClick={handleResetFilters}
                className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 transition-colors"
              >
                🔄 Reset Filters
              </button>
            </div>
          </div>
        </Card>

        {/* Claims table */}
        <Card>
          {isLoading ? (
            <div className="text-center py-12">
              <p className="text-gray-500">Loading claims…</p>
            </div>
          ) : error ? (
            <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
              <p className="text-sm text-red-700 font-medium">⚠️ {error}</p>
            </div>
          ) : filteredClaims.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-gray-500 text-sm">No claims found</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50">
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      ID
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Policy
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Incident
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Loss Date
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Prefecture
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Channel
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Severity
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Status
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Assigned
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Age
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Flags
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {filteredClaims.map((claim) => (
                    <ClaimRow
                      key={claim.id}
                      claim={claim}
                      onClick={handleClaimClick}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Results summary */}
          {!isLoading && !error && (
            <div className="mt-4 pt-4 border-t border-gray-200 text-xs text-gray-600">
              Showing {filteredClaims.length} of {claims.length} claims
            </div>
          )}
        </Card>
      </div>
    </Layout>
  );
};

export default ClaimQueue;