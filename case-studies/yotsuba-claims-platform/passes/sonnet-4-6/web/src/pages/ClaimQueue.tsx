/**
 * ClaimQueue.tsx
 *
 * Filterable claim list page for the Yotsuba Claims Adjuster Workbench.
 *
 * Design constraints:
 *  - Role-scoped list matching the API's GET /claims endpoint.
 *  - Filter chips for: status, severity, channel, age (days since loss).
 *  - Navigates to /claims/:id on row click.
 *  - Tailwind-only styling; no inline styles.
 *  - No `any`; strict TypeScript throughout.
 *  - Displays ClaimStatusPill and SeverityPill from sibling components.
 *  - Handles loading, error, and empty states.
 *  - Pagination with page size selector.
 */

import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { apiFetch } from '../lib/api';
import { useAuth } from '../lib/auth';
import { ClaimStatusPill } from '../components/ClaimStatusPill';
import { SeverityPill } from '../components/SeverityPill';
import type {
  ClaimStatus,
  ClaimSeverity,
  IntakeChannel,
  IncidentType,
  Claim,
} from '../lib/api';

// ─── Types ────────────────────────────────────────────────────────────────────

interface ClaimListItem {
  id: string;
  policy_number: string;
  loss_date: string;
  loss_location_prefecture: string;
  reported_by_channel: IntakeChannel;
  incident_type: IncidentType;
  severity_initial: ClaimSeverity;
  status: ClaimStatus;
  reporter_name: string;
  assigned_adjuster_id: string | null;
  assigned_adjuster_name?: string;
  created_at: string;
  updated_at: string;
}

interface PaginatedClaimsResponse {
  data: ClaimListItem[];
  total: number;
  page: number;
  pageSize: number;
}

interface ClaimQueueFilters {
  status: ClaimStatus | '';
  severity: ClaimSeverity | '';
  channel: IntakeChannel | '';
  ageDays: AgeFilter;
  search: string;
}

type AgeFilter = '' | '7' | '30' | '90' | '180';

const DEFAULT_FILTERS: ClaimQueueFilters = {
  status: '',
  severity: '',
  channel: '',
  ageDays: '',
  search: '',
};

const PAGE_SIZE_OPTIONS = [10, 25, 50] as const;
type PageSize = (typeof PAGE_SIZE_OPTIONS)[number];

// ─── Constants ────────────────────────────────────────────────────────────────

const ALL_STATUSES: ClaimStatus[] = [
  'intake',
  'under_investigation',
  'awaiting_reserve_approval',
  'settlement_offered',
  'closed_paid',
  'closed_denied',
  'reopened',
];

const ALL_SEVERITIES: ClaimSeverity[] = ['simple', 'complex', 'catastrophic'];

const ALL_CHANNELS: IntakeChannel[] = ['agent', 'mobile', 'broker', 'email'];

const AGE_FILTER_OPTIONS: { value: AgeFilter; label: string }[] = [
  { value: '', label: 'Any age' },
  { value: '7', label: 'Last 7 days' },
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '180', label: 'Last 180 days' },
];

const STATUS_LABELS: Record<ClaimStatus, string> = {
  intake: 'Intake',
  under_investigation: 'Under Investigation',
  awaiting_reserve_approval: 'Awaiting Reserve Approval',
  settlement_offered: 'Settlement Offered',
  closed_paid: 'Closed — Paid',
  closed_denied: 'Closed — Denied',
  reopened: 'Reopened',
};

const CHANNEL_LABELS: Record<IntakeChannel, string> = {
  agent: 'Agent',
  mobile: 'Mobile',
  broker: 'Broker',
  email: 'Email',
};

const INCIDENT_TYPE_LABELS: Record<IncidentType, string> = {
  auto_collision: 'Auto Collision',
  auto_property_damage: 'Auto Property Damage',
  fire_residential: 'Fire (Residential)',
  fire_commercial: 'Fire (Commercial)',
  marine_cargo: 'Marine Cargo',
  liability_premises: 'Liability (Premises)',
  personal_accident: 'Personal Accident',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatDate(iso: string): string {
  try {
    return new Date(iso).toLocaleDateString('en-JP', {
      year: 'numeric',
      month: 'short',
      day: 'numeric',
    });
  } catch {
    return iso;
  }
}

function formatDaysAgo(iso: string): string {
  try {
    const diffMs = Date.now() - new Date(iso).getTime();
    const days = Math.floor(diffMs / (1000 * 60 * 60 * 24));
    if (days === 0) return 'Today';
    if (days === 1) return '1 day ago';
    return `${days} days ago`;
  } catch {
    return iso;
  }
}

function buildQueryString(filters: ClaimQueueFilters, page: number, pageSize: PageSize): string {
  const params = new URLSearchParams();
  if (filters.status !== '') params.set('status', filters.status);
  if (filters.severity !== '') params.set('severity', filters.severity);
  if (filters.channel !== '') params.set('channel', filters.channel);
  if (filters.ageDays !== '') params.set('ageDays', filters.ageDays);
  if (filters.search.trim() !== '') params.set('search', filters.search.trim());
  params.set('page', String(page));
  params.set('pageSize', String(pageSize));
  return params.toString();
}

function countActiveFilters(filters: ClaimQueueFilters): number {
  let count = 0;
  if (filters.status !== '') count++;
  if (filters.severity !== '') count++;
  if (filters.channel !== '') count++;
  if (filters.ageDays !== '') count++;
  if (filters.search.trim() !== '') count++;
  return count;
}

// ─── Component ────────────────────────────────────────────────────────────────

/**
 * `<ClaimQueue>` — filterable, paginated claim list.
 *
 * Fetches claims from GET /claims with role-scoped results.
 * Supports filter chips for status, severity, channel, and age.
 * Clicking a row navigates to /claims/:id.
 *
 * @example
 * ```tsx
 * <Route path="/claims" element={<ClaimQueue />} />
 * ```
 */
export function ClaimQueue(): React.ReactElement {
  const { user } = useAuth();
  const navigate = useNavigate();

  const [filters, setFilters] = useState<ClaimQueueFilters>(DEFAULT_FILTERS);
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState<PageSize>(25);

  const [claims, setClaims] = useState<ClaimListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const activeFilterCount = countActiveFilters(filters);

  const fetchClaims = useCallback(async (): Promise<void> => {
    setIsLoading(true);
    setError(null);
    try {
      const qs = buildQueryString(filters, page, pageSize);
      const response = await apiFetch<PaginatedClaimsResponse | ClaimListItem[]>(
        `/claims?${qs}`,
      );
      // Handle both paginated and flat array responses from the API.
      if (Array.isArray(response)) {
        setClaims(response);
        setTotal(response.length);
      } else {
        setClaims(response.data);
        setTotal(response.total);
      }
    } catch (err) {
      setError(
        err instanceof Error ? err.message : 'Failed to load claims. Please try again.',
      );
    } finally {
      setIsLoading(false);
    }
  }, [filters, page, pageSize]);

  useEffect(() => {
    void fetchClaims();
  }, [fetchClaims]);

  // Reset to page 1 when filters change.
  const handleFilterChange = useCallback(
    <K extends keyof ClaimQueueFilters>(key: K, value: ClaimQueueFilters[K]): void => {
      setFilters((prev) => ({ ...prev, [key]: value }));
      setPage(1);
    },
    [],
  );

  const handleClearFilters = useCallback((): void => {
    setFilters(DEFAULT_FILTERS);
    setPage(1);
  }, []);

  const handleRowClick = useCallback(
    (id: string): void => {
      navigate(`/claims/${id}`);
    },
    [navigate],
  );

  const handlePageSizeChange = useCallback(
    (e: React.ChangeEvent<HTMLSelectElement>): void => {
      const newSize = Number(e.target.value) as PageSize;
      setPageSize(newSize);
      setPage(1);
    },
    [],
  );

  return (
    <div className="space-y-6">
      {/* Page header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Claim Queue</h1>
          <p className="mt-1 text-sm text-gray-500">
            {isLoading
              ? 'Loading claims…'
              : `${total.toLocaleString()} claim${total !== 1 ? 's' : ''}${
                  activeFilterCount > 0 ? ' matching filters' : ''
                }`}
          </p>
        </div>
        <div className="flex items-center gap-3">
          {user !== null && (
            <span className="text-xs text-gray-400">
              Role-scoped view for{' '}
              <span className="font-medium text-gray-600">{user.display_name}</span>
            </span>
          )}
          <button
            type="button"
            onClick={() => void fetchClaims()}
            disabled={isLoading}
            className="inline-flex items-center gap-1.5 rounded-lg px-3 py-2 text-sm font-medium text-gray-600 ring-1 ring-gray-200 hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-50 transition-colors"
          >
            <RefreshIcon className={['h-4 w-4', isLoading ? 'animate-spin' : ''].join(' ')} />
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
          <AlertIcon className="mt-0.5 h-4 w-4 flex-shrink-0 text-red-500" aria-hidden />
          <div className="min-w-0">
            <p className="text-sm font-medium text-red-700">Failed to load claims</p>
            <p className="mt-0.5 text-xs text-red-600">{error}</p>
          </div>
          <button
            type="button"
            onClick={() => void fetchClaims()}
            className="ml-auto flex-shrink-0 rounded px-2 py-1 text-xs font-medium text-red-700 hover:bg-red-100 transition-colors"
          >
            Retry
          </button>
        </div>
      )}

      {/* Claims table */}
      <ClaimsTable
        claims={claims}
        isLoading={isLoading}
        onRowClick={handleRowClick}
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
  filters: ClaimQueueFilters;
  activeFilterCount: number;
  onFilterChange: <K extends keyof ClaimQueueFilters>(key: K, value: ClaimQueueFilters[K]) => void;
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
      {/* Search bar */}
      <div className="relative">
        <div className="pointer-events-none absolute inset-y-0 left-0 flex items-center pl-3">
          <SearchIcon className="h-4 w-4 text-gray-400" aria-hidden />
        </div>
        <input
          type="search"
          value={filters.search}
          onChange={(e) => onFilterChange('search', e.target.value)}
          placeholder="Search by policy number, reporter name, or claim ID…"
          className="block w-full rounded-lg border border-gray-300 bg-white py-2 pl-9 pr-3 text-sm text-gray-900 placeholder-gray-400 focus:border-indigo-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors"
          aria-label="Search claims"
        />
      </div>

      {/* Filter chips row */}
      <div className="flex flex-wrap items-center gap-3">
        {/* Status filter */}
        <FilterChipSelect
          label="Status"
          value={filters.status}
          onChange={(v) => onFilterChange('status', v as ClaimStatus | '')}
          options={[
            { value: '', label: 'All statuses' },
            ...ALL_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] })),
          ]}
        />

        {/* Severity filter */}
        <FilterChipSelect
          label="Severity"
          value={filters.severity}
          onChange={(v) => onFilterChange('severity', v as ClaimSeverity | '')}
          options={[
            { value: '', label: 'All severities' },
            { value: 'simple', label: 'Simple' },
            { value: 'complex', label: 'Complex' },
            { value: 'catastrophic', label: 'Catastrophic' },
          ]}
        />

        {/* Channel filter */}
        <FilterChipSelect
          label="Channel"
          value={filters.channel}
          onChange={(v) => onFilterChange('channel', v as IntakeChannel | '')}
          options={[
            { value: '', label: 'All channels' },
            ...ALL_CHANNELS.map((c) => ({ value: c, label: CHANNEL_LABELS[c] })),
          ]}
        />

        {/* Age filter */}
        <FilterChipSelect
          label="Age"
          value={filters.ageDays}
          onChange={(v) => onFilterChange('ageDays', v as AgeFilter)}
          options={AGE_FILTER_OPTIONS}
        />

        {/* Clear all */}
        {activeFilterCount > 0 && (
          <button
            type="button"
            onClick={onClearFilters}
            className="inline-flex items-center gap-1.5 rounded-full px-3 py-1 text-xs font-medium text-red-600 ring-1 ring-red-200 hover:bg-red-50 transition-colors"
          >
            <XIcon className="h-3 w-3" />
            Clear {activeFilterCount} filter{activeFilterCount !== 1 ? 's' : ''}
          </button>
        )}
      </div>
    </div>
  );
}

// ─── Filter chip select ───────────────────────────────────────────────────────

interface FilterChipSelectProps {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: { value: string; label: string }[];
}

function FilterChipSelect({
  label,
  value,
  onChange,
  options,
}: FilterChipSelectProps): React.ReactElement {
  const isActive = value !== '';
  return (
    <div className="relative">
      <label className="sr-only">{label}</label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className={[
          'appearance-none cursor-pointer rounded-full py-1 pl-3 pr-7 text-xs font-medium ring-1 ring-inset focus:outline-none focus:ring-2 focus:ring-indigo-500 transition-colors',
          isActive
            ? 'bg-indigo-600 text-white ring-indigo-500'
            : 'bg-white text-gray-600 ring-gray-300 hover:bg-gray-50',
        ].join(' ')}
        aria-label={`Filter by ${label}`}
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
      <div className="pointer-events-none absolute inset-y-0 right-0 flex items-center pr-2">
        <ChevronDownIcon
          className={['h-3 w-3', isActive ? 'text-indigo-200' : 'text-gray-400'].join(' ')}
        />
      </div>
    </div>
  );
}

// ─── Claims table ─────────────────────────────────────────────────────────────

interface ClaimsTableProps {
  claims: ClaimListItem[];
  isLoading: boolean;
  onRowClick: (id: string) => void;
}

function ClaimsTable({
  claims,
  isLoading,
  onRowClick,
}: ClaimsTableProps): React.ReactElement {
  if (isLoading) {
    return <ClaimsTableSkeleton />;
  }

  if (claims.length === 0) {
    return <ClaimsEmptyState />;
  }

  return (
    <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-gray-200">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200" role="grid">
          <thead className="bg-gray-50">
            <tr>
              <Th>Claim ID</Th>
              <Th>Policy</Th>
              <Th>Incident</Th>
              <Th>Prefecture</Th>
              <Th>Channel</Th>
              <Th>Loss Date</Th>
              <Th>Age</Th>
              <Th>Severity</Th>
              <Th>Status</Th>
              <Th>Assigned To</Th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {claims.map((claim) => (
              <ClaimRow key={claim.id} claim={claim} onRowClick={onRowClick} />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ─── Claim row ────────────────────────────────────────────────────────────────

interface ClaimRowProps {
  claim: ClaimListItem;
  onRowClick: (id: string) => void;
}

function ClaimRow({ claim, onRowClick }: ClaimRowProps): React.ReactElement {
  const shortId = claim.id.slice(0, 8).toUpperCase();

  return (
    <tr
      className="group cursor-pointer hover:bg-indigo-50/40 transition-colors focus-within:bg-indigo-50/40"
      onClick={() => onRowClick(claim.id)}
      role="row"
    >
      {/* Claim ID */}
      <td className="whitespace-nowrap px-4 py-3">
        <button
          type="button"
          className="font-mono text-xs font-semibold text-indigo-600 group-hover:text-indigo-700 group-hover:underline focus:outline-none focus:underline"
          onClick={(e) => {
            e.stopPropagation();
            onRowClick(claim.id);
          }}
          aria-label={`View claim ${shortId}`}
        >
          {shortId}
        </button>
      </td>

      {/* Policy number */}
      <td className="whitespace-nowrap px-4 py-3">
        <span className="font-mono text-xs text-gray-700">{claim.policy_number}</span>
      </td>

      {/* Incident type */}
      <td className="whitespace-nowrap px-4 py-3">
        <span className="text-sm text-gray-700">
          {INCIDENT_TYPE_LABELS[claim.incident_type]}
        </span>
      </td>

      {/* Prefecture */}
      <td className="whitespace-nowrap px-4 py-3">
        <span className="text-sm text-gray-600">{claim.loss_location_prefecture}</span>
      </td>

      {/* Channel */}
      <td className="whitespace-nowrap px-4 py-3">
        <ChannelBadge channel={claim.reported_by_channel} />
      </td>

      {/* Loss date */}
      <td className="whitespace-nowrap px-4 py-3">
        <span className="text-sm text-gray-600">{formatDate(claim.loss_date)}</span>
      </td>

      {/* Age */}
      <td className="whitespace-nowrap px-4 py-3">
        <span className="text-xs text-gray-400">{formatDaysAgo(claim.created_at)}</span>
      </td>

      {/* Severity */}
      <td className="whitespace-nowrap px-4 py-3">
        <SeverityPill severity={claim.severity_initial} />
      </td>

      {/* Status */}
      <td className="whitespace-nowrap px-4 py-3">
        <ClaimStatusPill status={claim.status} />
      </td>

      {/* Assigned to */}
      <td className="whitespace-nowrap px-4 py-3">
        {claim.assigned_adjuster_id !== null ? (
          <span className="inline-flex items-center gap-1.5 text-sm text-gray-700">
            <UserCircleIcon className="h-4 w-4 flex-shrink-0 text-gray-400" aria-hidden />
            {claim.assigned_adjuster_name ?? claim.assigned_adjuster_id.slice(0, 8)}
          </span>
        ) : (
          <span className="text-xs text-gray-400 italic">Unassigned</span>
        )}
      </td>
    </tr>
  );
}

// ─── Table skeleton ───────────────────────────────────────────────────────────

function ClaimsTableSkeleton(): React.ReactElement {
  return (
    <div className="overflow-hidden rounded-xl bg-white shadow-sm ring-1 ring-gray-200">
      <div className="overflow-x-auto">
        <table className="min-w-full divide-y divide-gray-200">
          <thead className="bg-gray-50">
            <tr>
              {['Claim ID', 'Policy', 'Incident', 'Prefecture', 'Channel', 'Loss Date', 'Age', 'Severity', 'Status', 'Assigned To'].map(
                (h) => (
                  <th
                    key={h}
                    className="px-4 py-3 text-left text-xs font-semibold uppercase tracking-wider text-gray-500"
                  >
                    {h}
                  </th>
                ),
              )}
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-100 bg-white">
            {Array.from({ length: 8 }, (_, i) => (
              <tr key={i}>
                {Array.from({ length: 10 }, (__, j) => (
                  <td key={j} className="px-4 py-3">
                    <div
                      className="h-4 animate-pulse rounded bg-gray-100"
                      style={{ width: `${60 + ((i * 7 + j * 13) % 40)}%` }}
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

function ClaimsEmptyState(): React.ReactElement {
  return (
    <div className="flex flex-col items-center justify-center gap-4 rounded-xl border border-dashed border-gray-300 bg-white px-6 py-16 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-full bg-gray-100">
        <InboxIcon className="h-7 w-7 text-gray-400" aria-hidden />
      </div>
      <div>
        <p className="text-sm font-semibold text-gray-700">No claims found</p>
        <p className="mt-1 text-xs text-gray-400">
          No claims match your current filters. Try adjusting or clearing the
          filters.
        </p>
      </div>
    </div>
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
        claims
      </p>

      {/* Controls */}
      <div className="flex items-center gap-4">
        {/* Page size */}
        <div className="flex items-center gap-2">
          <label htmlFor="page-size" className="text-xs text-gray-500">
            Per page:
          </label>
          <select
            id="page-size"
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
        <nav className="flex items-center gap-1" aria-label="Pagination">
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

interface PaginationButtonProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
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

// ─── Channel badge ────────────────────────────────────────────────────────────

const CHANNEL_COLOUR: Record<IntakeChannel, string> = {
  agent: 'bg-blue-50 text-blue-700 ring-blue-600/20',
  mobile: 'bg-green-50 text-green-700 ring-green-600/20',
  broker: 'bg-purple-50 text-purple-700 ring-purple-600/20',
  email: 'bg-amber-50 text-amber-700 ring-amber-600/20',
};

function ChannelBadge({ channel }: { channel: IntakeChannel }): React.ReactElement {
  return (
    <span
      className={[
        'inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ring-1 ring-inset',
        CHANNEL_COLOUR[channel],
      ].join(' ')}
    >
      {CHANNEL_LABELS[channel]}
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

// ─── SVG icons ────────────────────────────────────────────────────────────────

interface IconProps {
  className?: string;
  'aria-hidden'?: boolean | 'true' | 'false';
}

function SearchIcon({ className = 'h-4 w-4', ...rest }: IconProps): React.ReactElement {
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
        d="M8 4a4 4 0 100 8 4 4 0 000-8zM2 8a6 6 0 1110.89 3.476l4.817 4.817a1 1 0 01-1.414 1.414l-4.816-4.816A6 6 0 012 8z"
        clipRule="evenodd"
      />
    </svg>
  );
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

function InboxIcon({ className = 'h-6 w-6', ...rest }: IconProps): React.ReactElement {
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
        d="M5 3a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2V5a2 2 0 00-2-2H5zm0 2h10v7h-2.101a2 2 0 00-1.899 1.368A1 1 0 019.07 14H10.93a1 1 0 01-.93.632H5V5z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function UserCircleIcon({ className = 'h-4 w-4', ...rest }: IconProps): React.ReactElement {
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
        d="M18 10a8 8 0 11-16 0 8 8 0 0116 0zm-6-3a2 2 0 11-4 0 2 2 0 014 0zm-2 4a5 5 0 00-4.546 2.916A5.986 5.986 0 0010 16a5.986 5.986 0 004.546-2.084A5 5 0 0010 11z"
        clipRule="evenodd"
      />
    </svg>
  );
}

function ChevronDownIcon({ className = 'h-3 w-3', ...rest }: IconProps): React.ReactElement {
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

function ChevronLeftIcon({ className = 'h-3.5 w-3.5', ...rest }: IconProps): React.ReactElement {
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

function ChevronRightIcon({ className = 'h-3.5 w-3.5', ...rest }: IconProps): React.ReactElement {
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