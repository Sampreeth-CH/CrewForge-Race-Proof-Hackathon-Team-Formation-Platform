import { useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Search, History } from 'lucide-react';
import { api } from '../lib/api';

interface AuditLogEntry {
  id: string;
  actorId: string | null;
  actorName: string | null;
  teamId: string | null;
  hackathonId: string | null;
  action: string;
  targetUserId: string | null;
  targetName: string | null;
  metadata: Record<string, unknown>;
  createdAt: string;
}

interface AuditResponse {
  logs: AuditLogEntry[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

const AUDIT_ACTIONS = [
  'TEAM_CREATED',
  'TEAM_UPDATED',
  'TEAM_DELETED',
  'MEMBERSHIP_CREATED',
  'JOIN_REQUEST_CREATED',
  'JOIN_REQUEST_ACCEPTED',
  'JOIN_REQUEST_REJECTED',
  'MEMBER_REMOVED',
  'MEMBER_LEFT',
  'LEADER_TRANSFERRED',
  'INVITE_CREATED',
  'INVITE_REVOKED',
  'INVITE_REDEEMED',
  'RACE_LAB_RUN',
];

export function AuditExplorerPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [teamId, setTeamId] = useState(searchParams.get('teamId') || '');
  const [action, setAction] = useState('');
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);

  const { data, isLoading } = useQuery({
    queryKey: ['audit-logs', { teamId, action, q, page }],
    queryFn: async () => {
      const params: Record<string, string | number> = { page, limit: 25 };
      if (teamId.trim()) params.teamId = teamId.trim();
      if (action) params.action = action;
      if (q.trim()) params.q = q.trim();
      return (await api.get<AuditResponse>('/audit-logs', { params })).data;
    },
  });

  const logs = data?.logs ?? [];
  const pagination = data?.pagination;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="border-b border-white/[0.08] pb-6">
        <h1 className="font-display text-2xl font-bold text-white sm:text-3xl">
          Audit Explorer
        </h1>
        <p className="mt-1 text-sm text-slate-400">
          Immutable transactional ledger of team formations, seat acquisitions, leadership transfers,
          and deletions. Audit logs remain queryable even after teams are deleted.
        </p>
      </div>

      {/* Filters */}
      <div className="mt-6 grid grid-cols-1 gap-3 rounded-xl border border-white/[0.08] bg-[#11151E] p-4 sm:grid-cols-3">
        <div className="relative">
          <label htmlFor="audit-q" className="sr-only">
            Search audit logs
          </label>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            id="audit-q"
            type="search"
            value={q}
            onChange={(e) => {
              setQ(e.target.value);
              setPage(1);
            }}
            placeholder="Search actor, action, or metadata..."
            className="w-full rounded-lg border border-white/10 bg-[#090B10] py-2 pl-9 pr-3 text-sm text-white placeholder:text-slate-500 focus:border-[#3B82F6] focus:outline-none"
          />
        </div>

        <div>
          <label htmlFor="audit-action" className="sr-only">
            Filter by action
          </label>
          <select
            id="audit-action"
            value={action}
            onChange={(e) => {
              setAction(e.target.value);
              setPage(1);
            }}
            className="w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2 text-sm text-white focus:border-[#3B82F6] focus:outline-none"
          >
            <option value="">All Audit Actions</option>
            {AUDIT_ACTIONS.map((a) => (
              <option key={a} value={a}>
                {a}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label htmlFor="audit-team-id" className="sr-only">
            Filter by Team UUID
          </label>
          <input
            id="audit-team-id"
            type="text"
            value={teamId}
            onChange={(e) => {
              setTeamId(e.target.value);
              setPage(1);
              if (e.target.value) setSearchParams({ teamId: e.target.value });
              else setSearchParams({});
            }}
            placeholder="Filter by Team UUID..."
            className="w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2 font-mono text-xs text-white placeholder:text-slate-500 focus:border-[#3B82F6] focus:outline-none"
          />
        </div>
      </div>

      {/* Table */}
      <div className="mt-6 overflow-hidden rounded-xl border border-white/[0.08] bg-[#11151E]">
        {isLoading ? (
          <div className="space-y-3 p-6">
            {Array.from({ length: 6 }).map((_, idx) => (
              <div key={idx} className="h-10 animate-pulse rounded bg-white/5" />
            ))}
          </div>
        ) : logs.length === 0 ? (
          <div className="p-12 text-center">
            <History className="mx-auto h-7 w-7 text-slate-500" />
            <p className="mt-2 text-sm font-medium text-white">No audit records match your filter</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-xs">
              <thead>
                <tr className="border-b border-white/[0.08] bg-[#090B10] text-slate-400">
                  <th className="px-4 py-3 font-medium">Timestamp</th>
                  <th className="px-4 py-3 font-medium">Action</th>
                  <th className="px-4 py-3 font-medium">Actor</th>
                  <th className="px-4 py-3 font-medium">Team ID</th>
                  <th className="px-4 py-3 font-medium">Target</th>
                  <th className="px-4 py-3 font-medium">Metadata</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-white/[0.06]">
                {logs.map((log) => (
                  <tr key={log.id} className="hover:bg-white/[0.02]">
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-slate-400 tabular-nums">
                      {new Date(log.createdAt).toLocaleString()}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono font-semibold text-[#3B82F6]">
                      {log.action}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-slate-200">
                      {log.actorName || (log.actorId ? log.actorId.slice(0, 8) : 'System')}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 font-mono text-slate-400">
                      {log.teamId ? log.teamId.slice(0, 8) : '—'}
                    </td>
                    <td className="whitespace-nowrap px-4 py-3 text-slate-300">
                      {log.targetName || (log.targetUserId ? log.targetUserId.slice(0, 8) : '—')}
                    </td>
                    <td className="max-w-xs truncate px-4 py-3 font-mono text-[11px] text-slate-400">
                      {JSON.stringify(log.metadata)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {pagination && pagination.totalPages > 1 && (
        <div className="mt-6 flex items-center justify-between text-xs text-slate-400">
          <span className="font-mono tabular-nums">
            Page {pagination.page} of {pagination.totalPages} · {pagination.total} records
          </span>
          <div className="flex items-center gap-2">
            <button
              type="button"
              disabled={page <= 1}
              onClick={() => setPage((p) => Math.max(1, p - 1))}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-slate-200 hover:bg-white/5 disabled:opacity-40"
            >
              Previous
            </button>
            <button
              type="button"
              disabled={page >= pagination.totalPages}
              onClick={() => setPage((p) => p + 1)}
              className="rounded-lg border border-white/10 px-3 py-1.5 text-slate-200 hover:bg-white/5 disabled:opacity-40"
            >
              Next
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
