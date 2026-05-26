/**
 * AuditLog.tsx
 *
 * Auditor-only view of the immutable audit event log.
 *
 * Design constraints (from design.md §2, brief.md):
 *  - Consumes GET /audit?from=&to=&actor=&claim_id=&action=
 *  - Read-only; auditor role only (enforced server-side; UI reflects this)
 *  - Displays every AuditEvent: actor, action, claim_id, target_id,
 *    payload_hash, request_id, correlation_id, timestamp
 *  - Filter bar: date range, actor, claim_id, action free-text
 *  - Pagination with page size selector
 *  - Tailwind-only styling; no inline styles
 *  - No `any`; strict TypeScript throughout
 *  - Handles loading, error, and empty states
 *  - Audit log is append-only; no write actions exposed
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/auth';
import type { UserRole } from '../lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface AuditEvent {
  id: string;
  actor_id: string;
  actor_role: UserRole;
  action: string;
  claim_id: string | null;
  target_id: string | null;
  payload_hash: string;
  request_id: string;
  correlation_id: string;
  ts: string;
}

interface PaginatedAuditResponse {
  data: AuditEvent[];
  total: number;
  page: number;
  pageSize: number;
}

interface AuditFilters {
  from: string;
  to: string;
  actor: string;
  claim_id: string;
  action: string;
}

const DEFAULT_FILTERS: AuditFilters = {
  from: '',
  to: '',
  actor: '',
  claim_id: '',
  action: '',
};

const PAGE_SIZE_OPTIONS = [25, 50, 100] as const;
type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

// ─── Constants ────────────────────────────────────────────────────────────────

const KNOWN_ACTIONS = [
  'claim.created',
  'claim.assigned',
  'claim.status.changed',
  'claim.note.add',
  'claim.evidence.add',
  'claim.witness_statement.add',
  'reserve.proposed',
  'reserve.approved',
  'reserve.director_approved',
  'reserve.rejected',
  'data_subject.export',
  'personal_data.anonymised',
  'auth.login',
] as const;

const ROLE_STYLES: Record<UserRole, string> = {
  agent: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  adjuster: 'bg-green-50 text-green-700 ring-green-600/20',
  manager: 'bg-purple-50 text-purple-700 ring-purple-600/20',
  auditor: 'bg-amber-50 text-amber-700 ring-amber-600/20',
  siu_referrer: 'bg-rose-50 text-rose-700 ring-rose-600/20',
};

const ACTION_COLOUR: (action: string) => string = (action) => {
  if (action.includes('created') || action.includes('add') || action.includes('proposed')) {
    return 'bg-blue-400';
  }
  if (action.includes('approved') || action.includes('login')) {
    return 'bg-green-400';
  }
  if (action.includes('rejected') || action.includes('denied') || action.includes('anonymised')) {
    return 'bg-red-400';
  }
  if (action.includes('status') || action.includes('assigned')) {
    return 'bg-amber-400';
  }
  if (action.includes('export')) {
    return 'bg-indigo-400';
  }
  return 'bg-gray-400';
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDateTime(iso: string): string {
  try {
    return new Date(iso).toLocaleString('en-JP', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  } catch {
    return iso;
  }
}

function formatDateTimeLocal(iso: string): string {
  if (iso === '') return '';
  try {
    // Convert ISO to datetime-local input format (YYYY-MM-DDTHH:mm)
    return new Date(iso).toISOString().slice(0, 16);
  } catch {
    return iso;
  }
}

function buildQueryString(
  filters: AuditFilters,
  page: number,
  pageSize: PageSize,
): string {
  const params = new URLSearchParams();
  if (filters.from.trim() !== '') params.set('from', new Date(filters.from).toISOString());
  if (filters.to.trim() !== '') params.set('to', new Date(filters.to).toISOString());
  if (filters.actor.trim() !== '') params.set('actor', filters.actor.trim());
  if (filters.claim_id.trim() !== '') params.set('claim_id', filters.claim_id.trim());
  if (filters.action.trim() !== '') params.set('action', filters.action.trim());
  params.set('page', String(page));
  params.set('pageSize', String(pageSize));
  return params.toString();
}

function countActiveFilters(filters: AuditFilters): number {
  return Object.values(filters).filter((v) => v.trim() !== '').length;
}

function truncateHash(hash: string, len = 12): string {
  return hash.length > len ? hash.slice(0, len) + '…' : hash;
}

function truncateId(id: string, len = 8): string {
  return id.slice(0, len).toUpperCase();
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * `<AuditLog>` — immutable audit event log viewer for the auditor role.
 *
 * Fetches events from GET /audit with date range, actor, claim_id, and action
 * filters. All entries are read-only; no write operations are exposed.
 * Pagination with configurable page size.
 *
 * @example
 * ```tsx
 * <Route path="/audit" element={<AuditLog />} />
 * ```
 */
export function AuditLog(): React.ReactElement {
  const { user } = useAuth();

  const [filters, setFilters] = useState<AuditFilters>(DEFAULT_FILTERS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(50);

  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // For expanded row detail.
  const [expandedId, setExpandedId] = useState<string | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const activeFilterCount = countActiveFilters(filters);

  const fetchEvents = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setError(null);
    try {
      const qs = buildQueryString(filters, page, pageSize);
      const response = await apiFetch<PaginatedAuditResponse | AuditEvent[]>(
        `/audit?${qs}`,
      );
      if (Array.isArray(response)) {
        setEvents(response);
        setTotal(response.length);
      } else {
        setEvents(response.data);
        setTotal(response.total);
      }
    } catch (err) {
      setError(
        err instanceof Error
          ? err.message
          : 'Failed to load audit events. Please try again.',
      );
    } finally {
      setIsLoading(false);
    }
  }, [filters, page, pageSize]);

  useEffect(() => {
    void fetchEvents();
  }, [fetchEvents]);

  const handleFilterChange = useCallback(
    <K extends keyof AuditFilters>(key: K, value: AuditFilters[K]): void => {
      setFilters((prev) => ({ ...prev, [key]: value }));
      setPage(1);
    },
    [],
  );

  const handleClearFilters = useCallback((): void => {
    setFilters(DEFAULT_FILTERS);
    setPage(1);
  }, []);

  const handlePageSizeChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>): void => {
      setPageSize(Number(e.target.value) as PageSize);
      setPage(1);
    },
    [],
  );

  const handleToggleExpand = useCallback((id: string): void => {
    setExpandedId((prev) => (prev === id ? null : id));
  }, []);

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Audit Log</h1>
          <p className="mt-1 text-sm text-gray-500">
            {isLoading
              ? 'Loading audit events…'
              : `${total.toLocaleString()} event${
                  total !== 1 ? 's' : ''
                }${activeFilterCount > 0 ? ' matching filters' : ''}`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {/* Immutability notice */}
          <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-3 py-1 text-xs font-medium text-amber-700 ring-1 ring-inset ring-amber-600/20">
            <LockClosedIcon className="h-3.5 w-3.5" aria-hidden />
            Append-only · No writes
          </span>

          {user !== null && (
            <span className="text-xs text-gray-400">
              Viewing as{' '}
              <span className="font-medium text-gray-600">{user.display_name}</span>
            </span>
          )}

          <button
            type="button"
            onClick={() => void fetchEvents()}
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

      {/* Filters panel */}
      <FiltersPanel
        filters={filters}
        activeFilterCount={activeFilterCount}
        onFilterChange={handleFilterChange}
        onClearFilters={handleClearFilters}
      />

      {/* Error state */}
      {error !== null && (
        <div
          role="alert"
          className="flex items-start gap-3 rounded-lg bg-red-50 px-4 py-3 ring-1 ring-inset ring-red-200"
        >
          <AlertIcon
            className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-500"
            aria-hidden
          />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-red-700">Failed to load audit events</p>
            <p className="mt-0.5 text-xs text-red-600">{error}</p>
          </div>
          <button
            type="button"
            onClick={() => void fetchEvents()}
            className="ml-auto flex-shrink-0 rounded px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Audit events list */}
      <AuditEventList
        events={events}
        isLoading={isLoading}
        expandedId={expandedId}
        onToggleExpand={handleToggleExpand}
      />

      {/* Pagination */}
      {!isLoading && error === null && total > 0 && (
        <PaginationBar
          page={page}
          totalPages={totalPages}
          total={total}
          pageSize={pageSize}
          onPageChange={setPage}
          onPageSizeChange={handlePageSizeChange}
        />
      )}
    </div>
  );
}

// ─── Filters panel ────────────────────────────────────────────────────────────

interface FiltersPanelProps {
  filters: AuditFilters;
  activeFilterCount: number;
  onFilterChange: <K extends keyof AuditFilters>(key: K, value: AuditFilters[K]) => void;
  onClearFilters: () => void;
}

function FiltersPanel({
  filters,
  activeFilterCount,
  onFilterChange,
  onClearFilters,
}: FiltersPanelProps): React.ReactElement {
  return (
    <div className="rounded-xl bg-white px-5 py-4 shadow-sm ring-1 ring-gray-200 space-y-4">
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {/* From date */}
        <div>
          <label
            htmlFor="filter-from"
            className="block text-xs font-medium text-gray-600 mb-1"
          >
            From
          </label>
          <input
            id="filter-from"
            type="datetime-local"
            value={formatDateTimeLocal(filters.from)}
            onChange={(e) =>
              onFilterChange('from', e.target.value ? new Date(e.target.value).toISOString() : '')
            }
            className="block w-full rounded-lg border border-gray-300 bg-white py-2 px-3 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors"
            aria-label="Filter from date"
          />
        </div>

        {/* To date */}
        <div>
          <label
            htmlFor="filter-to"
            className="block text-xs font-medium text-gray-600 mb-1"
          >
            To
          </label>
          <input
            id="filter-to"
            type="datetime-local"
            value={formatDateTimeLocal(filters.to)}
            onChange={(e) =>
              onFilterChange('to', e.target.value ? new Date(e.target.value).toISOString() : '')
            }
            className="block w-full rounded-lg border border-gray-300 bg-white py-2 px-3 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors"
            aria-label="Filter to date"
          />
        </div>

        {/* Action filter */}
        <div>
          <label
            htmlFor="filter-action"
            className="block text-xs font-medium text-gray-600 mb-1"
          >
            Action
          </label>
          <div className="relative">
            <select
              id="filter-action"
              value={filters.action}
              onChange={(e) => onFilterChange('action', e.target.value)}
              className="block w-full appearance-none rounded-lg border border-gray-300 bg-white py-2 pl-3 pr-8 text-sm text-gray-900 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors"
              aria-label="Filter by action"
            >
              <option value="">All actions</option>
              {KNOWN_ACTIONS.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
            <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2">
              <ChevronDownIcon className="h-3.5 w-3.5 text-gray-400" />
            </div>
          </div>
        </div>

        {/* Actor filter */}
        <div>
          <label
            htmlFor="filter-actor"
            className="block text-xs font-medium text-gray-600 mb-1"
          >
            Actor ID / Username
          </label>
          <div className="relative">
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
              <UserIcon className="h-3.5 w-3.5 text-gray-400" aria-hidden />
            </div>
            <input
              id="filter-actor"
              type="text"
              value={filters.actor}
              onChange={(e) => onFilterChange('actor', e.target.value)}
              placeholder="e.g. adjuster01 or cuid…"
              className="block w-full rounded-lg border border-gray-300 bg-white py-2 pl-8 pr-3 text-sm text-gray-900 placeholder-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors"
              aria-label="Filter by actor"
            />
          </div>
        </div>

        {/* Claim ID filter */}
        <div>
          <label
            htmlFor="filter-claim-id"
            className="block text-xs font-medium text-gray-600 mb-1"
          >
            Claim ID
          </label>
          <div className="relative">
            <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
              <DocumentIcon className="h-3.5 w-3.5 text-gray-400" aria-hidden />
            </div>
            <input
              id="filter-claim-id"
              type="text"
              value={filters.claim_id}
              onChange={(e) => onFilterChange('claim_id', e.target.value)}
              placeholder="Claim CUID…"
              className="block w-full rounded-lg border border-gray-300 bg-white py-2 pl-8 pr-3 text-sm text-gray-900 placeholder-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors"
              aria-label="Filter by claim ID"
            />
          </div>
        </div>

        {/* Clear filters */}
        {activeFilterCount > 0 && (
          <div className="flex items-end">
            <button
              type="button"
              onClick={onClearFilters}
              className="inline-flex items-center gap-1.5 rounded-full px-3 py-2 text-xs font-medium text-red-600 ring-1 ring-red-200 hover:bg-red-50 transition-colors"
            >
              <XIcon className="h-3 w-3" />
              Clear {activeFilterCount} filter{activeFilterCount !== 1 ? 's' : ''}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

// ─── Audit event list ─────────────────────────────────────────────────────────

interface AuditEventListProps {
  events: AuditEvent[];
  isLoading: boolean;
  expandedId: string | null;
  onToggleExpand: (id: string) => void;
}

function AuditEventList({
  events,
  isLoading,
  expandedId,
  onToggleExpand,
}: AuditEventListProps): React.ReactElement {
  if (isLoading) {
    return <AuditListSkeleton />;
  }

  if (events.length === 0) {
    return <AuditEmptyState />;
  }

  return (
    <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-gray-200">
      {/* Table header */}
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200" role="grid">
          <thead className="bg-gray-50">
            <tr>
              <Th>Timestamp</Th>
              <Th>Action</Th>
              <Th>Actor</Th>
              <Th>Role</Th>
              <Th>Claim ID</Th>
              <Th>Target ID</Th>
              <Th>Payload Hash</Th>
              <Th>
                <span className="sr-only">Expand</span>
              </Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {events.map((event) => (
              <AuditEventRow
                key={event.id}
                event={event}
                isExpanded={expandedId === event.id}
                onToggleExpand={onToggleExpand}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Audit event row ──────────────────────────────────────────────────────────

interface AuditEventRowProps {
  event: AuditEvent;
  isExpanded: boolean;
  onToggleExpand: (id: string) => void;
}

function AuditEventRow({
  event,
  isExpanded,
  onToggleExpand,
}: AuditEventRowProps): React.ReactElement {
  const dotColour = ACTION_COLOUR(event.action);

  return (
    <>
      <tr
        className="group cursor-pointer hover:bg-gray-50/60 transition-colors"
        onClick={() => onToggleExpand(event.id)}
        aria-expanded={isExpanded}
        role="row"
      >
        {/* Timestamp */}
        <td className="whitespace-nowrap px-4 py-3">
          <span className="font-mono text-xs text-gray-500">
            {formatDateTime(event.ts)}
          </span>
        </td>

        {/* Action */}
        <td className="whitespace-nowrap px-4 py-3">
          <span className="inline-flex items-center gap-1.5">
            <span
              className={['inline-block h-2 w-2 flex-shrink-0 rounded-full', dotColour].join(' ')}
              aria-hidden
            />
            <span className="font-mono text-xs font-medium text-gray-800">
              {event.action}
            </span>
          </span>
        </td>

        {/* Actor ID */}
        <td className="whitespace-nowrap px-4 py-3">
          <span className="font-mono text-xs text-gray-600">
            {truncateId(event.actor_id)}
          </span>
        </td>

        {/* Actor role */}
        <td className="whitespace-nowrap px-4 py-3">
          <RoleBadgeInline role={event.actor_role} />
        </td>

        {/* Claim ID */}
        <td className="whitespace-nowrap px-4 py-3">
          {event.claim_id !== null ? (
            <span className="font-mono text-xs text-indigo-600">
              {truncateId(event.claim_id)}
            </span>
          ) : (
            <span className="text-xs text-gray-300">—</span>
          )}
        </td>

        {/* Target ID */}
        <td className="whitespace-nowrap px-4 py-3">
          {event.target_id !== null ? (
            <span className="font-mono text-xs text-gray-500">
              {truncateId(event.target_id)}
            </span>
          ) : (
            <span className="text-xs text-gray-300">—</span>
          )}
        </td>

        {/* Payload hash */}
        <td className="whitespace-nowrap px-4 py-3">
          <span
            className="font-mono text-xs text-gray-400"
            title={event.payload_hash}
          >
            {truncateHash(event.payload_hash)}
          </span>
        </td>

        {/* Expand toggle */}
        <td className="whitespace-nowrap px-4 py-3">
          <button
            type="button"
            aria-label={isExpanded ? 'Collapse event details' : 'Expand event details'}
            onClick={(e) => {
              e.stopPropagation();
              onToggleExpand(event.id);
            }}
            className="rounded-md p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 transition-colors focus:outline-none focus:ring-2 focus:ring-indigo-500"
          >
            <ChevronDownIcon
              className={[
                'h-4 w-4 transition-transform',
                isExpanded ? 'rotate-180' : 'rotate-0',
              ].join(' ')}
            />
          </button>
        </td>
      </tr>

      {/* Expanded detail row */}
      {isExpanded && (
        <tr className="bg-gray-50/80">
          <td colSpan={8} className="px-4 py-4">
            <AuditEventDetail event={event} />
          </td>
        </tr>
      )}
    </>
  );
}

// ─── Audit event detail ───────────────────────────────────────────────────────

interface AuditEventDetailProps {
  event: AuditEvent;
}

function AuditEventDetail({ event }: AuditEventDetailProps): React.ReactElement {
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
      <DetailField label="Event ID" value={event.id} mono />
      <DetailField label="Actor ID" value={event.actor_id} mono />
      <DetailField label="Actor Role" value={event.actor_role} />
      <DetailField label="Action" value={event.action} mono />
      <DetailField label="Timestamp" value={formatDateTime(event.ts)} />
      {event.claim_id !== null && (
        <DetailField label="Claim ID" value={event.claim_id} mono />
      )}
      {event.target_id !== null && (
        <DetailField label="Target ID" value={event.target_id} mono />
      )}
      <DetailField label="Request ID" value={event.request_id} mono />
      <DetailField label="Correlation ID" value={event.correlation_id} mono />
      <div className="sm:col-span-2 lg:col-span-3">
        <p className="text-xs font-semibold uppercase tracking-wider text-gray-400 mb-1">
          Payload Hash (SHA-256)
        </p>
        <p className="break-all font-mono text-xs text-gray-600 rounded-lg bg-white px-3 py-2 ring-1 ring-inset ring-gray-200">
          {event.payload_hash}
        </p>
      </div>
    </div>
  );
}

// ─── Detail field ─────────────────────────────────────────────────────────────

interface DetailFieldProps {
  label: string;
  value: string;
  mono?: boolean;
}

function DetailField({ label, value, mono = false }: DetailFieldProps): React.ReactElement {
  return (
    <div>
      <p className="text-xs font-semibold uppercase tracking-wider text-gray-400">{label}</p>
      <p
        className={[
          'mt-0.5 text-sm text-gray-700 break-all',
          mono ? 'font-mono' : '',
        ].join(' ')}
      >
        {value}
      </p>
    </div>
  );
}

// ─── Role badge (inline variant) ──────────────────────────────────────────────

function RoleBadgeInline({ role }: { role: UserRole }): React.ReactElement {
  return (
    <span
      className={[
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        ROLE_STYLES[role],
      ].join(' ')}
    >
      {role}
    </span>
  );
}

// ─── Table header cell ────────────────────────────────────────────────────────

function Th({ children }: { children: React.ReactNode }): React.ReactElement {
  return (
    <th
      scope="col"
      className="whitespace-nowrap px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500"
    >
      {children}
    </th>
  );
}

// ─── Pagination bar ───────────────────────────────────────────────────────────

interface PaginationBarProps {
  page: number;
  totalPages: number;
  total: number;
  pageSize: PageSize;
  onPageChange: (page: number) => void;
  onPageSizeChange: (e: React.ChangeEvent<HTMLSelectElement>) => void;
}

function PaginationBar({
  page,
  totalPages,
  total,
  pageSize,
  onPageChange,
  onPageSizeChange,
}: PaginationBarProps): React.ReactElement {
  const startItem = (page - 1) * pageSize + 1;
  const endItem = Math.min(page * pageSize, total);

  return (
    <div className="flex flex-col items-center justify-between gap-4 rounded-xl bg-white px-5 py-3 shadow-sm ring-1 ring-gray-200 sm:flex-row">
      {/* Range summary */}
      <p className="text-sm text-gray-500">
        Showing{' '}
        <span className="font-medium text-gray-800">{startItem}</span>–
        <span className="font-medium text-gray-800">{endItem}</span>{' '}
        of{' '}
        <span className="font-medium text-gray-800">{total.toLocaleString()}</span>{' '}
        events
      </p>

      {/* Controls */}
      <div className="flex items-center gap-4">
        {/* Page size */}
        <div className="flex items-center gap-2">
          <label htmlFor="audit-page-size" className="text-xs text-gray-500">
            Per page:
          </label>
          <select
            id="audit-page-size"
            value={pageSize}
            onChange={onPageSizeChange}
            className="rounded-lg border border-gray-300 bg-white py-1 pl-2 pr-6 text-xs text-gray-700 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors"
          >
            {PAGE_SIZE_OPTIONS.map((size) => (
              <option key={size} value={size}>
                {size}
              </option>
            ))}
          </select>
        </div>

        {/* Page nav */}
        <nav className="flex items-center gap-1" aria-label="Audit log pagination">
          <PaginationButton
            onClick={() => onPageChange(1)}
            disabled={page <= 1}
            aria-label="First page"
          >
            <ChevronDoubleLeftIcon className="h-3.5 w-3.5" />
          </PaginationButton>
          <PaginationButton
            onClick={() => onPageChange(page - 1)}
            disabled={page <= 1}
            aria-label="Previous page"
          >
            <ChevronLeftIcon className="h-3.5 w-3.5" />
          </PaginationButton>

          <span className="px-3 text-xs text-gray-600">
            {page} / {totalPages}
          </span>

          <PaginationButton
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages}
            aria-label="Next page"
          >
            <ChevronRightIcon className="h-3.5 w-3.5" />
          </PaginationButton>
          <PaginationButton
            onClick={() => onPageChange(totalPages)}
            disabled={page >= totalPages}
            aria-label="Last page"
          >
            <ChevronDoubleRightIcon className="h-3.5 w-3.5" />
          </PaginationButton>
        </nav>
      </div>
    </div>
  );
}

interface PaginationButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  children: React.ReactNode;
}

function PaginationButton({
  children,
  disabled,
  ...rest
}: PaginationButtonProps): React.ReactElement {
  return (
    <button
      type="button"
      disabled={disabled}
      className="inline-flex h-7 w-7 items-center justify-center rounded-md text-gray-500 ring-1 ring-gray-200 hover:bg-gray-50 hover:text-gray-700 disabled:cursor-not-allowed disabled:opacity-40 transition-colors"
      {...rest}
    >
      {children}
    </button>
  );
}

// ─── Skeleton loader ──────────────────────────────────────────────────────────

function AuditListSkeleton(): React.ReactElement {
  const COLS = ['Timestamp', 'Action', 'Actor', 'Role', 'Claim ID', 'Target ID', 'Payload Hash', ''];
  return (
    <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-gray-200">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              {COLS.map((h, i) => (
                <th
                  key={i}
                  className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500"
                >
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {Array.from({ length: 10 }, (_, i) => (
              <tr key={i}>
                {COLS.map((_, j) => (
                  <td key={j} className="px-4 py-3">
                    <div
                      className="h-4 animate-pulse rounded bg-gray-100"
                      style={{ width: `${55 + ((i * 11 + j * 17) % 40)}%` }}
                    />
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Empty state ──────────────────────────────────────────────────────────────

function AuditEmptyState(): React.ReactElement {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-gray-300 bg-white px-6 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gray-100">
        <ClipboardListIcon className="h-7 w-7 text-gray-400" aria-hidden />
      </div>
      <div>
        <p className="text-sm font-semibold text-gray-700">No audit events found</p>
        <p className="mt-1 text-xs text-gray-400">
          No events match your current filters. Try adjusting or clearing the
          filters, or selecting a wider date range.
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

function LockClosedIcon({
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
        d="M5 9V7a5 5 0 0110 0v2a2 2 0 012 2v5a2 2 0 01-2 2H5a2 2 0 01-2-2v-5a2 2 0 012-2zm8-2v2H7V7a3 3 0 016 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function UserIcon({ className = 'h-4 w-4', ...rest }: IconProps): React.ReactElement {
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
        d="M10 9a3 3 0 100-6 3 3 0 000 6zm-7 9a7 7 0 1114 0H3z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function DocumentIcon({
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
        d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4zm2 6a1 1 0 011-1h6a1 1 0 110 2H7a1 1 0 01-1-1zm1 3a1 1 0 100 2h6a1 1 0 100-2H7z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function ClipboardListIcon({
  className = 'h-6 w-6',
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
      <path d="M9 2a1 1 0 000 2h2a1 1 0 100-2H9z" />
      <path
        fillRule="evenodd"
        d="M4 5a2 2 0 012-2 3 3 0 003 3h2a3 3 0 003-3 2 2 0 012 2v11a2 2 0 01-2 2H6a2 2 0 01-2-2V5zm3 4a1 1 0 000 2h.01a1 1 0 100-2H7zm3 0a1 1 0 000 2h3a1 1 0 100-2h-3zm-3 4a1 1 0 100 2h.01a1 1 0 100-2H7zm3 0a1 1 0 100 2h3a1 1 0 100-2h-3z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function XIcon({ className = 'h-3 w-3', ...rest }: IconProps): React.ReactElement {
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

function ChevronDownIcon({
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
        d="M5.293 7.293a1 1 0 011.414 0L10 10.586l3.293-3.293a1 1 0 111.414 1.414l-4 4a1 1 0 01-1.414 0l-4-4a1 1 0 010-1.414z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function ChevronLeftIcon({
  className = 'h-3.5 w-3.5',
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
        d="M12.707 5.293a1 1 0 010 1.414L9.414 10l3.293 3.293a1 1 0 01-1.414 1.414l-4-4a1 1 0 010-1.414l4-4a1 1 0 011.414 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function ChevronRightIcon({
  className = 'h-3.5 w-3.5',
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
        d="M7.293 14.707a1 1 0 010-1.414L10.586 10 7.293 6.707a1 1 0 011.414-1.414l4 4a1 1 0 010 1.414l-4 4a1 1 0 01-1.414 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function ChevronDoubleLeftIcon({
  className = 'h-3.5 w-3.5',
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
        d="M15.707 15.707a1 1 0 01-1.414 0l-5-5a1 1 0 010-1.414l5-5a1 1 0 111.414 1.414L11.414 10l4.293 4.293a1 1 0 010 1.414zm-6 0a1 1 0 01-1.414 0l-5-5a1 1 0 010-1.414l5-5a1 1 0 011.414 1.414L5.414 10l4.293 4.293a1 1 0 010 1.414z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function ChevronDoubleRightIcon({
  className = 'h-3.5 w-3.5',
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
        d="M10.293 15.707a1 1 0 010-1.414L14.586 10l-4.293-4.293a1 1 0 111.414-1.414l5 5a1 1 0 010 1.414l-5 5a1 1 0 01-1.414 0zm-6 0a1 1 0 010-1.414L8.586 10 4.293 5.707a1 1 0 011.414-1.414l5 5a1 1 0 010 1.414l-5 5a1 1 0 01-1.414 0z"
        clipRule="evenodd"
      />
    </svg>
  );
}