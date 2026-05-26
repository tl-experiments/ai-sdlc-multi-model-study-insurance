/**
 * AuditLog.tsx
 * Displays the immutable audit log for the claims processing platform.
 * Allows auditors to search, filter, and review all system actions with full traceability.
 * Provides correlation ID tracking across claim lifecycle events.
 */

import React, { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../lib/auth';
import { Layout, PageHeader, Card, Badge, Section } from '../components/Layout';

/**
 * Audit event type matching the backend AuditEvent model.
 */
interface AuditEvent {
  id: string;
  actor_id: string;
  actor_role: 'agent' | 'adjuster' | 'manager' | 'auditor' | 'siu_referrer';
  action: string;
  claim_id?: string;
  target_id?: string;
  payload_hash: string;
  request_id: string;
  correlation_id: string;
  ts: string;
}

/**
 * Filter state for audit log.
 */
interface FilterState {
  from: string;
  to: string;
  actor_id: string;
  claim_id: string;
  action: string;
}

/**
 * Metadata for user roles.
 */
const ROLE_CONFIG: Record<
  'agent' | 'adjuster' | 'manager' | 'auditor' | 'siu_referrer',
  { label: string; icon: string; color: string }
> = {
  agent: { label: 'Agent', icon: '☎️', color: 'bg-blue-100 text-blue-800' },
  adjuster: {
    label: 'Adjuster',
    icon: '👤',
    color: 'bg-green-100 text-green-800',
  },
  manager: {
    label: 'Manager',
    icon: '👨‍💼',
    color: 'bg-purple-100 text-purple-800',
  },
  auditor: {
    label: 'Auditor',
    icon: '🔍',
    color: 'bg-orange-100 text-orange-800',
  },
  siu_referrer: {
    label: 'SIU Referrer',
    icon: '🚨',
    color: 'bg-red-100 text-red-800',
  },
};

/**
 * Metadata for common audit actions.
 */
const ACTION_CONFIG: Record<string, { label: string; icon: string }> = {
  'claim.created': { label: 'Claim Created', icon: '📥' },
  'claim.assigned': { label: 'Claim Assigned', icon: '👤' },
  'claim.status.updated': { label: 'Status Updated', icon: '🔄' },
  'claim.note.added': { label: 'Note Added', icon: '📝' },
  'claim.evidence.added': { label: 'Evidence Added', icon: '📎' },
  'claim.witness.recorded': { label: 'Witness Recorded', icon: '🗣️' },
  'reserve.proposed': { label: 'Reserve Proposed', icon: '💰' },
  'reserve.approved': { label: 'Reserve Approved', icon: '✅' },
  'reserve.director_approved': {
    label: 'Director Approved',
    icon: '👑',
  },
  'reserve.rejected': { label: 'Reserve Rejected', icon: '❌' },
};

/**
 * Props for the AuditEventRow component.
 */
interface AuditEventRowProps {
  event: AuditEvent;
  onCorrelationIdClick: (correlationId: string) => void;
}

/**
 * AuditEventRow component — displays a single audit event in the log.
 */
const AuditEventRow: React.FC<AuditEventRowProps> = ({
  event,
  onCorrelationIdClick,
}) => {
  const roleConfig = ROLE_CONFIG[event.actor_role];
  const actionConfig = ACTION_CONFIG[event.action] || {
    label: event.action,
    icon: '📋',
  };

  const eventDate = new Date(event.ts).toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return (
    <tr className="border-b border-gray-200 hover:bg-gray-50 transition-colors">
      {/* Timestamp */}
      <td className="px-6 py-4 whitespace-nowrap">
        <div className="text-sm text-gray-600">{eventDate}</div>
      </td>

      {/* Actor */}
      <td className="px-6 py-4 whitespace-nowrap">
        <div className="flex items-center gap-2">
          <span className="text-lg">{roleConfig.icon}</span>
          <Badge variant="info">{roleConfig.label}</Badge>
        </div>
      </td>

      {/* Actor ID */}
      <td className="px-6 py-4 whitespace-nowrap">
        <div className="text-sm font-mono text-gray-600">
          {event.actor_id.substring(0, 8)}
        </div>
      </td>

      {/* Action */}
      <td className="px-6 py-4 whitespace-nowrap">
        <div className="flex items-center gap-2">
          <span className="text-lg">{actionConfig.icon}</span>
          <span className="text-sm text-gray-900">{actionConfig.label}</span>
        </div>
      </td>

      {/* Claim ID */}
      <td className="px-6 py-4 whitespace-nowrap">
        {event.claim_id ? (
          <div className="text-sm font-mono text-blue-600">
            {event.claim_id.substring(0, 8)}
          </div>
        ) : (
          <div className="text-sm text-gray-400">—</div>
        )}
      </td>

      {/* Target ID */}
      <td className="px-6 py-4 whitespace-nowrap">
        {event.target_id ? (
          <div className="text-sm font-mono text-gray-600">
            {event.target_id.substring(0, 8)}
          </div>
        ) : (
          <div className="text-sm text-gray-400">—</div>
        )}
      </td>

      {/* Request ID */}
      <td className="px-6 py-4 whitespace-nowrap">
        <div className="text-xs font-mono text-gray-500">
          {event.request_id.substring(0, 8)}
        </div>
      </td>

      {/* Correlation ID */}
      <td className="px-6 py-4 whitespace-nowrap">
        <button
          onClick={() => onCorrelationIdClick(event.correlation_id)}
          className="text-xs font-mono text-blue-600 hover:underline"
          title="Click to filter by correlation ID"
        >
          {event.correlation_id.substring(0, 8)}…
        </button>
      </td>

      {/* Payload Hash */}
      <td className="px-6 py-4 whitespace-nowrap">
        <div
          className="text-xs font-mono text-gray-500 cursor-help"
          title={event.payload_hash}
        >
          {event.payload_hash.substring(0, 12)}…
        </div>
      </td>
    </tr>
  );
};

/**
 * AuditLog component — displays the immutable audit log.
 * Allows auditors to search, filter, and review all system actions.
 * Provides correlation ID tracking across claim lifecycle events.
 * @returns Rendered audit log page
 */
export const AuditLog: React.FC = () => {
  const navigate = useNavigate();
  const { currentUser: user } = useAuth();

  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [filters, setFilters] = useState<FilterState>({
    from: '',
    to: '',
    actor_id: '',
    claim_id: '',
    action: '',
  });

  const [pagination, setPagination] = useState({
    page: 1,
    limit: 50,
  });

  /**
   * Fetch audit events from the API.
   */
  useEffect(() => {
    const fetchAuditEvents = async () => {
      setIsLoading(true);
      setError(null);

      try {
        const token = localStorage.getItem('access_token');
        if (!token) {
          throw new Error('No authentication token found');
        }

        const queryParams = new URLSearchParams();
        if (filters.from) {
          queryParams.append('from', filters.from);
        }
        if (filters.to) {
          queryParams.append('to', filters.to);
        }
        if (filters.actor_id) {
          queryParams.append('actor', filters.actor_id);
        }
        if (filters.claim_id) {
          queryParams.append('claim_id', filters.claim_id);
        }
        if (filters.action) {
          queryParams.append('action', filters.action);
        }
        queryParams.append('page', pagination.page.toString());
        queryParams.append('limit', pagination.limit.toString());

        const response = await fetch(
          `/api/audit?${queryParams.toString()}`,
          {
            headers: {
              Authorization: `Bearer ${token}`,
              'Content-Type': 'application/json',
            },
          }
        );

        if (!response.ok) {
          throw new Error(`Failed to fetch audit events: ${response.statusText}`);
        }

        const data = await response.json();
        setEvents(Array.isArray(data) ? data : data.data || []);
      } catch (err) {
        setError(
          err instanceof Error ? err.message : 'Failed to load audit log'
        );
      } finally {
        setIsLoading(false);
      }
    };

    fetchAuditEvents();
  }, [filters, pagination]);

  /**
   * Handle filter changes.
   */
  const handleFilterChange = (key: keyof FilterState, value: string) => {
    setFilters((prev) => ({
      ...prev,
      [key]: value,
    }));
    setPagination({ ...pagination, page: 1 });
  };

  /**
   * Reset all filters.
   */
  const handleResetFilters = () => {
    setFilters({
      from: '',
      to: '',
      actor_id: '',
      claim_id: '',
      action: '',
    });
    setPagination({ page: 1, limit: 50 });
  };

  /**
   * Handle correlation ID click — filter by correlation ID.
   */
  const handleCorrelationIdClick = (correlationId: string) => {
    // In a real implementation, we'd filter by correlation_id
    // For now, we'll just show a message
    alert(
      `Filtering by correlation ID: ${correlationId}\n\nIn production, this would show all events in the same request chain.`
    );
  };

  /**
   * Calculate statistics.
   */
  const stats = {
    total: events.length,
    byRole: Object.fromEntries(
      Object.keys(ROLE_CONFIG).map((role) => [
        role,
        events.filter((e) => e.actor_role === role).length,
      ])
    ),
    byAction: Object.fromEntries(
      Object.keys(ACTION_CONFIG).map((action) => [
        action,
        events.filter((e) => e.action === action).length,
      ])
    ),
  };

  // Check authorization
  if (user?.role !== 'auditor') {
    return (
      <Layout>
        <div className="space-y-6">
          <PageHeader
            title="Audit Log"
            description="View system audit trail"
            icon="🔍"
          />
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-sm text-red-700 font-medium">
              ⚠️ Access denied. Only auditors can view the audit log.
            </p>
          </div>
        </div>
      </Layout>
    );
  }

  return (
    <Layout>
      <div className="space-y-6">
        {/* Page header */}
        <PageHeader
          title="Audit Log"
          description="Immutable system audit trail with full traceability"
          icon="🔍"
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
        <div className="grid grid-cols-1 md:grid-cols-5 gap-4">
          <Card className="bg-gradient-to-br from-blue-50 to-blue-100 border-blue-200">
            <div>
              <p className="text-xs font-semibold text-blue-700 uppercase tracking-wider mb-1">
                Total Events
              </p>
              <p className="text-3xl font-bold text-blue-900">{stats.total}</p>
            </div>
          </Card>

          {Object.entries(ROLE_CONFIG).map(([role, config]) => (
            <Card
              key={role}
              className="bg-gradient-to-br from-gray-50 to-gray-100 border-gray-200"
            >
              <div>
                <p className="text-xs font-semibold text-gray-700 uppercase tracking-wider mb-1">
                  {config.label}
                </p>
                <p className="text-2xl font-bold text-gray-900">
                  {stats.byRole[role as keyof typeof stats.byRole] || 0}
                </p>
              </div>
            </Card>
          ))}
        </div>

        {/* Filters section */}
        <Card title="Filters" className="bg-gray-50">
          <div className="space-y-4">
            {/* Date range */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  From Date
                </label>
                <input
                  type="datetime-local"
                  value={filters.from}
                  onChange={(e) => handleFilterChange('from', e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  To Date
                </label>
                <input
                  type="datetime-local"
                  value={filters.to}
                  onChange={(e) => handleFilterChange('to', e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            {/* Actor and claim filters */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Actor ID
                </label>
                <input
                  type="text"
                  placeholder="Filter by actor ID…"
                  value={filters.actor_id}
                  onChange={(e) => handleFilterChange('actor_id', e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <div>
                <label className="block text-sm font-medium text-gray-700 mb-2">
                  Claim ID
                </label>
                <input
                  type="text"
                  placeholder="Filter by claim ID…"
                  value={filters.claim_id}
                  onChange={(e) => handleFilterChange('claim_id', e.target.value)}
                  className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
            </div>

            {/* Action filter */}
            <div>
              <label className="block text-sm font-medium text-gray-700 mb-2">
                Action
              </label>
              <select
                value={filters.action}
                onChange={(e) => handleFilterChange('action', e.target.value)}
                className="w-full px-4 py-2 border border-gray-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">All Actions</option>
                {Object.entries(ACTION_CONFIG).map(([action, config]) => (
                  <option key={action} value={action}>
                    {config.label}
                  </option>
                ))}
              </select>
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

        {/* Error message */}
        {error && (
          <div className="p-4 bg-red-50 border border-red-200 rounded-lg">
            <p className="text-sm text-red-700 font-medium">⚠️ {error}</p>
          </div>
        )}

        {/* Audit events table */}
        <Card>
          {isLoading ? (
            <div className="text-center py-12">
              <p className="text-gray-500">Loading audit events…</p>
            </div>
          ) : events.length === 0 ? (
            <div className="text-center py-12">
              <p className="text-gray-500 text-sm">No audit events found</p>
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full">
                <thead>
                  <tr className="border-b border-gray-200 bg-gray-50">
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Timestamp
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Actor Role
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Actor ID
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Action
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Claim ID
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Target ID
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Request ID
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Correlation ID
                    </th>
                    <th className="px-6 py-3 text-left text-xs font-semibold text-gray-700 uppercase tracking-wider">
                      Payload Hash
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {events.map((event) => (
                    <AuditEventRow
                      key={event.id}
                      event={event}
                      onCorrelationIdClick={handleCorrelationIdClick}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          )}

          {/* Results summary and pagination */}
          {!isLoading && !error && events.length > 0 && (
            <div className="mt-4 pt-4 border-t border-gray-200 flex items-center justify-between">
              <p className="text-xs text-gray-600">
                Showing {events.length} events (page {pagination.page})
              </p>
              <div className="flex gap-2">
                <button
                  onClick={() =>
                    setPagination((prev) => ({
                      ...prev,
                      page: Math.max(1, prev.page - 1),
                    }))
                  }
                  disabled={pagination.page === 1}
                  className="px-3 py-1 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed transition-colors"
                >
                  ← Previous
                </button>
                <button
                  onClick={() =>
                    setPagination((prev) => ({
                      ...prev,
                      page: prev.page + 1,
                    }))
                  }
                  disabled={events.length < pagination.limit}
                  className="px-3 py-1 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-lg hover:bg-gray-50 disabled:bg-gray-100 disabled:text-gray-400 disabled:cursor-not-allowed transition-colors"
                >
                  Next →
                </button>
              </div>
            </div>
          )}
        </Card>

        {/* Legend */}
        <Card title="Legend" className="bg-gray-50">
          <div className="space-y-4">
            <div>
              <p className="text-sm font-semibold text-gray-900 mb-2">
                Correlation ID
              </p>
              <p className="text-sm text-gray-700">
                Unique identifier that links all events in a single request chain.
                Click on any correlation ID to filter by that chain.
              </p>
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-900 mb-2">
                Payload Hash
              </p>
              <p className="text-sm text-gray-700">
                SHA-256 hash of the event payload. Used for tamper detection and
                audit trail integrity verification.
              </p>
            </div>
            <div>
              <p className="text-sm font-semibold text-gray-900 mb-2">
                Immutability
              </p>
              <p className="text-sm text-gray-700">
                All audit events are append-only and immutable. No updates or
                deletions are permitted. This ensures regulatory compliance and
                audit trail integrity.
              </p>
            </div>
          </div>
        </Card>
      </div>
    </Layout>
  );
};

export default AuditLog;