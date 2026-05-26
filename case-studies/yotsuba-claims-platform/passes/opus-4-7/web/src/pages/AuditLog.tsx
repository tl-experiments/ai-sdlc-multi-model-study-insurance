import { useEffect, useMemo, useState } from 'react';
import { Layout } from '../components/Layout';
import { RoleBadge } from '../components/RoleBadge';
import { useAuth } from '../lib/auth';
import { api } from '../lib/api';

interface AuditEvent {
  id: string;
  actor_id: string;
  actor_role: 'agent' | 'adjuster' | 'manager' | 'auditor' | 'siu_referrer';
  action: string;
  claim_id: string | null;
  target_id: string | null;
  payload_hash: string;
  request_id: string;
  correlation_id: string;
  ts: string;
}

interface Filters {
  from: string;
  to: string;
  actor: string;
  claim_id: string;
  action: string;
}

const INITIAL_FILTERS: Filters = {
  from: '',
  to: '',
  actor: '',
  claim_id: '',
  action: '',
};

function formatTimestamp(ts: string): string {
  try {
    const d = new Date(ts);
    return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
  } catch {
    return ts;
  }
}

function shortHash(hash: string): string {
  if (!hash) return '';
  if (hash.length <= 12) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}

function actionColor(action: string): string {
  if (action.startsWith('claim.created')) return 'bg-emerald-100 text-emerald-800';
  if (action.startsWith('claim.status')) return 'bg-blue-100 text-blue-800';
  if (action.startsWith('claim.note')) return 'bg-slate-100 text-slate-800';
  if (action.startsWith('claim.evidence')) return 'bg-amber-100 text-amber-800';
  if (action.startsWith('claim.witness')) return 'bg-purple-100 text-purple-800';
  if (action.startsWith('claim.assign')) return 'bg-indigo-100 text-indigo-800';
  if (action.startsWith('reserve.approved')) return 'bg-green-100 text-green-800';
  if (action.startsWith('reserve.rejected')) return 'bg-rose-100 text-rose-800';
  if (action.startsWith('reserve')) return 'bg-cyan-100 text-cyan-800';
  if (action.startsWith('appi')) return 'bg-fuchsia-100 text-fuchsia-800';
  return 'bg-gray-100 text-gray-800';
}

export function AuditLogPage(): JSX.Element {
  const { user } = useAuth();
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [filters, setFilters] = useState<Filters>(INITIAL_FILTERS);
  const [applied, setApplied] = useState<Filters>(INITIAL_FILTERS);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [selected, setSelected] = useState<AuditEvent | null>(null);

  const isAuditor = user?.role === 'auditor';

  const queryString = useMemo(() => {
    const qs = new URLSearchParams();
    if (applied.from) qs.set('from', applied.from);
    if (applied.to) qs.set('to', applied.to);
    if (applied.actor) qs.set('actor', applied.actor);
    if (applied.claim_id) qs.set('claim_id', applied.claim_id);
    if (applied.action) qs.set('action', applied.action);
    const s = qs.toString();
    return s.length > 0 ? `?${s}` : '';
  }, [applied]);

  useEffect(() => {
    if (!isAuditor) return;
    let cancelled = false;
    setLoading(true);
    setError(null);
    api
      .get<AuditEvent[]>(`/audit${queryString}`)
      .then((rows) => {
        if (!cancelled) setEvents(rows);
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Failed to load audit log');
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [queryString, isAuditor]);

  function onChange<K extends keyof Filters>(key: K, value: Filters[K]): void {
    setFilters((f) => ({ ...f, [key]: value }));
  }

  function onApply(e: React.FormEvent): void {
    e.preventDefault();
    setApplied(filters);
  }

  function onReset(): void {
    setFilters(INITIAL_FILTERS);
    setApplied(INITIAL_FILTERS);
  }

  if (!isAuditor) {
    return (
      <Layout title="Audit Log">
        <div className="rounded-lg border border-amber-300 bg-amber-50 p-6 text-amber-900">
          <h2 className="text-lg font-semibold">Restricted view</h2>
          <p className="mt-1 text-sm">
            The audit log is only accessible to users with the <strong>auditor</strong> role. Your current role is
            {' '}
            <RoleBadge role={user?.role ?? 'agent'} />.
          </p>
        </div>
      </Layout>
    );
  }

  return (
    <Layout title="Audit Log">
      <div className="space-y-4">
        <form
          onSubmit={onApply}
          className="grid grid-cols-1 gap-3 rounded-lg border border-slate-200 bg-white p-4 shadow-sm md:grid-cols-6"
        >
          <div className="flex flex-col">
            <label htmlFor="f-from" className="text-xs font-medium text-slate-600">From</label>
            <input
              id="f-from"
              type="datetime-local"
              value={filters.from}
              onChange={(e) => onChange('from', e.target.value)}
              className="mt-1 rounded border border-slate-300 px-2 py-1 text-sm focus:border-slate-500 focus:outline-none"
            />
          </div>
          <div className="flex flex-col">
            <label htmlFor="f-to" className="text-xs font-medium text-slate-600">To</label>
            <input
              id="f-to"
              type="datetime-local"
              value={filters.to}
              onChange={(e) => onChange('to', e.target.value)}
              className="mt-1 rounded border border-slate-300 px-2 py-1 text-sm focus:border-slate-500 focus:outline-none"
            />
          </div>
          <div className="flex flex-col">
            <label htmlFor="f-actor" className="text-xs font-medium text-slate-600">Actor ID</label>
            <input
              id="f-actor"
              type="text"
              value={filters.actor}
              onChange={(e) => onChange('actor', e.target.value)}
              placeholder="user id"
              className="mt-1 rounded border border-slate-300 px-2 py-1 text-sm focus:border-slate-500 focus:outline-none"
            />
          </div>
          <div className="flex flex-col">
            <label htmlFor="f-claim" className="text-xs font-medium text-slate-600">Claim ID</label>
            <input
              id="f-claim"
              type="text"
              value={filters.claim_id}
              onChange={(e) => onChange('claim_id', e.target.value)}
              placeholder="claim id"
              className="mt-1 rounded border border-slate-300 px-2 py-1 text-sm focus:border-slate-500 focus:outline-none"
            />
          </div>
          <div className="flex flex-col">
            <label htmlFor="f-action" className="text-xs font-medium text-slate-600">Action</label>
            <input
              id="f-action"
              type="text"
              value={filters.action}
              onChange={(e) => onChange('action', e.target.value)}
              placeholder="e.g. claim.created"
              className="mt-1 rounded border border-slate-300 px-2 py-1 text-sm focus:border-slate-500 focus:outline-none"
            />
          </div>
          <div className="flex items-end gap-2">
            <button
              type="submit"
              className="flex-1 rounded bg-slate-800 px-3 py-1.5 text-sm font-medium text-white hover:bg-slate-700"
            >
              Apply
            </button>
            <button
              type="button"
              onClick={onReset}
              className="flex-1 rounded border border-slate-300 bg-white px-3 py-1.5 text-sm font-medium text-slate-700 hover:bg-slate-50"
            >
              Reset
            </button>
          </div>
        </form>

        {error !== null && (
          <div className="rounded border border-rose-300 bg-rose-50 px-3 py-2 text-sm text-rose-800">
            {error}
          </div>
        )}

        <div className="overflow-hidden rounded-lg border border-slate-200 bg-white shadow-sm">
          <div className="flex items-center justify-between border-b border-slate-200 bg-slate-50 px-4 py-2">
            <span className="text-sm font-medium text-slate-700">
              {loading ? 'Loading…' : `${events.length} event${events.length === 1 ? '' : 's'}`}
            </span>
            <span className="text-xs text-slate-500">Append-only · tamper-evident (payload_hash)</span>
          </div>
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200 text-sm">
              <thead className="bg-slate-50">
                <tr className="text-left text-xs uppercase tracking-wide text-slate-500">
                  <th className="px-4 py-2 font-medium">Timestamp</th>
                  <th className="px-4 py-2 font-medium">Action</th>
                  <th className="px-4 py-2 font-medium">Actor</th>
                  <th className="px-4 py-2 font-medium">Claim</th>
                  <th className="px-4 py-2 font-medium">Correlation</th>
                  <th className="px-4 py-2 font-medium">Payload Hash</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {events.length === 0 && !loading && (
                  <tr>
                    <td colSpan={6} className="px-4 py-8 text-center text-sm text-slate-500">
                      No audit events match the current filters.
                    </td>
                  </tr>
                )}
                {events.map((ev) => (
                  <tr
                    key={ev.id}
                    onClick={() => setSelected(ev)}
                    className="cursor-pointer hover:bg-slate-50"
                  >
                    <td className="whitespace-nowrap px-4 py-2 font-mono text-xs text-slate-700">
                      {formatTimestamp(ev.ts)}
                    </td>
                    <td className="px-4 py-2">
                      <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${actionColor(ev.action)}`}>
                        {ev.action}
                      </span>
                    </td>
                    <td className="px-4 py-2">
                      <div className="flex items-center gap-2">
                        <RoleBadge role={ev.actor_role} />
                        <span className="font-mono text-xs text-slate-600">{ev.actor_id.slice(0, 10)}</span>
                      </div>
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-700">
                      {ev.claim_id ?? '—'}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-600">
                      {shortHash(ev.correlation_id)}
                    </td>
                    <td className="px-4 py-2 font-mono text-xs text-slate-600">
                      {shortHash(ev.payload_hash)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {selected !== null && (
          <div
            className="fixed inset-0 z-30 flex items-center justify-center bg-slate-900/50 p-4"
            onClick={() => setSelected(null)}
          >
            <div
              className="max-h-[80vh] w-full max-w-2xl overflow-auto rounded-lg bg-white p-6 shadow-xl"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-4 flex items-start justify-between">
                <div>
                  <h3 className="text-lg font-semibold text-slate-900">Audit Event Detail</h3>
                  <p className="mt-0.5 text-xs text-slate-500">ID: <span className="font-mono">{selected.id}</span></p>
                </div>
                <button
                  type="button"
                  onClick={() => setSelected(null)}
                  className="rounded p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                  aria-label="Close"
                >
                  ✕
                </button>
              </div>
              <dl className="grid grid-cols-3 gap-x-4 gap-y-2 text-sm">
                <dt className="text-slate-500">Timestamp</dt>
                <dd className="col-span-2 font-mono">{formatTimestamp(selected.ts)}</dd>

                <dt className="text-slate-500">Action</dt>
                <dd className="col-span-2">
                  <span className={`inline-block rounded px-2 py-0.5 text-xs font-medium ${actionColor(selected.action)}`}>
                    {selected.action}
                  </span>
                </dd>

                <dt className="text-slate-500">Actor</dt>
                <dd className="col-span-2 flex items-center gap-2">
                  <RoleBadge role={selected.actor_role} />
                  <span className="font-mono text-xs">{selected.actor_id}</span>
                </dd>

                <dt className="text-slate-500">Claim ID</dt>
                <dd className="col-span-2 font-mono text-xs">{selected.claim_id ?? '—'}</dd>

                <dt className="text-slate-500">Target ID</dt>
                <dd className="col-span-2 font-mono text-xs">{selected.target_id ?? '—'}</dd>

                <dt className="text-slate-500">Request ID</dt>
                <dd className="col-span-2 font-mono text-xs break-all">{selected.request_id}</dd>

                <dt className="text-slate-500">Correlation ID</dt>
                <dd className="col-span-2 font-mono text-xs break-all">{selected.correlation_id}</dd>

                <dt className="text-slate-500">Payload Hash</dt>
                <dd className="col-span-2 font-mono text-xs break-all">{selected.payload_hash}</dd>
              </dl>
              <div className="mt-6 rounded border border-slate-200 bg-slate-50 p-3 text-xs text-slate-600">
                The <code className="font-mono">payload_hash</code> is a SHA-256 of the canonical event payload
                at write time. Any subsequent mutation of the event would invalidate this hash; combined with
                the append-only write path, this gives tamper-evident audit semantics (ADR-002).
              </div>
            </div>
          </div>
        )}
      </div>
    </Layout>
  );
}

export default AuditLogPage;