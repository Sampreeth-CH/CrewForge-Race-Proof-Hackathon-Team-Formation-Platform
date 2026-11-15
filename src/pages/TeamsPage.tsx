import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Search, Users, Radio, ArrowRight, CheckCircle2, Clock, Lock } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useRealtime } from '../context/RealtimeContext';
import { CreateTeamModal, HackathonSummary } from '../components/CreateTeamModal';

interface TeamSummary {
  id: string;
  hackathonId: string;
  hackathonName: string;
  minTeamSize: number;
  name: string;
  description: string;
  leaderId: string;
  leaderName: string;
  leaderTimezone: string;
  memberCount: number;
  maxCapacity: number;
  openSeats: number;
  requiredSkills: string[];
  status: 'forming' | 'ready' | 'locked';
  createdAt: string;
}

interface TeamsResponse {
  teams: TeamSummary[];
  pagination: {
    page: number;
    limit: number;
    total: number;
    totalPages: number;
  };
}

export function TeamsPage() {
  const { user } = useAuth();
  const { connected } = useRealtime();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();

  const [hackathonId, setHackathonId] = useState(searchParams.get('hackathonId') || '');
  const [status, setStatus] = useState<'all' | 'forming' | 'ready' | 'locked'>('all');
  const [search, setSearch] = useState('');
  const [skill, setSkill] = useState('');
  const [openOnly, setOpenOnly] = useState(false);
  const [page, setPage] = useState(1);
  const [createOpen, setCreateOpen] = useState(false);

  const { data: hackathonsData } = useQuery({
    queryKey: ['hackathons'],
    queryFn: async () => (await api.get<{ hackathons: HackathonSummary[] }>('/hackathons')).data,
  });
  const hackathons = hackathonsData?.hackathons ?? [];

  const { data, isLoading, isError } = useQuery({
    queryKey: ['teams', { hackathonId, status, search, skill, openOnly, page }],
    queryFn: async () => {
      const params: Record<string, string | number | boolean> = { page, limit: 12 };
      if (hackathonId) params.hackathonId = hackathonId;
      if (status !== 'all') params.status = status;
      if (search.trim()) params.q = search.trim();
      if (skill.trim()) params.skill = skill.trim();
      if (openOnly) params.openOnly = true;
      const res = await api.get<TeamsResponse>('/teams', { params });
      return res.data;
    },
  });

  const teams = data?.teams ?? [];
  const pagination = data?.pagination;

  const renderStatusLabel = (s: TeamSummary['status']) => {
    if (s === 'ready') {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-emerald-400">
          <CheckCircle2 className="h-3.5 w-3.5" />
          Ready
        </span>
      );
    }
    if (s === 'locked') {
      return (
        <span className="inline-flex items-center gap-1.5 text-xs font-medium text-red-400">
          <Lock className="h-3.5 w-3.5" />
          Locked
        </span>
      );
    }
    return (
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-amber-400">
        <Clock className="h-3.5 w-3.5" />
        Forming
      </span>
    );
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-col justify-between gap-4 border-b border-white/[0.08] pb-6 sm:flex-row sm:items-center">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="font-display text-2xl font-bold text-white sm:text-3xl">
              Team Discovery Board
            </h1>
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400">
              <Radio className={`h-3.5 w-3.5 ${connected ? 'text-emerald-400' : 'text-amber-400'}`} />
              {connected ? 'Live SSE' : 'Syncing'}
            </span>
          </div>
          <p className="mt-1 text-sm text-slate-400">
            Paginated, indexed PostgreSQL discovery board updated automatically on transaction commit.
          </p>
        </div>

        {user ? (
          <button
            type="button"
            onClick={() => setCreateOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#3B82F6] px-4 py-2 text-xs font-semibold text-white hover:bg-[#2563EB] whitespace-nowrap shrink-0"
          >
            <Plus className="h-4 w-4" />
            Create Team
          </button>
        ) : (
          <Link
            to="/login"
            className="rounded-lg bg-[#3B82F6] px-4 py-2 text-xs font-semibold text-white hover:bg-[#2563EB] whitespace-nowrap shrink-0"
          >
            Sign In to Join
          </Link>
        )}
      </div>

      {/* Filters Toolbar */}
      <div className="mt-6 grid grid-cols-1 gap-3 rounded-xl border border-white/[0.08] bg-[#11151E] p-4 lg:grid-cols-12">
        <div className="relative lg:col-span-4">
          <label htmlFor="team-search" className="sr-only">
            Search teams
          </label>
          <Search className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-slate-500" />
          <input
            id="team-search"
            type="search"
            value={search}
            onChange={(e) => {
              setSearch(e.target.value);
              setPage(1);
            }}
            placeholder="Search team name or pitch..."
            className="w-full rounded-lg border border-white/10 bg-[#090B10] py-2 pl-9 pr-3 text-sm text-white placeholder:text-slate-500 focus:border-[#3B82F6] focus:outline-none"
          />
        </div>

        <div className="lg:col-span-3">
          <label htmlFor="filter-hackathon" className="sr-only">
            Filter by hackathon
          </label>
          <select
            id="filter-hackathon"
            value={hackathonId}
            onChange={(e) => {
              setHackathonId(e.target.value);
              setPage(1);
              if (e.target.value) {
                setSearchParams({ hackathonId: e.target.value });
              } else {
                setSearchParams({});
              }
            }}
            className="w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2 text-sm text-white focus:border-[#3B82F6] focus:outline-none"
          >
            <option value="">All Hackathons</option>
            {hackathons.map((h) => (
              <option key={h.id} value={h.id}>
                {h.name}
              </option>
            ))}
          </select>
        </div>

        <div className="lg:col-span-2">
          <label htmlFor="filter-skill" className="sr-only">
            Filter by required skill
          </label>
          <input
            id="filter-skill"
            type="text"
            value={skill}
            onChange={(e) => {
              setSkill(e.target.value);
              setPage(1);
            }}
            placeholder="Skill (e.g. Rust)"
            className="w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2 text-sm text-white placeholder:text-slate-500 focus:border-[#3B82F6] focus:outline-none"
          />
        </div>

        <div className="flex flex-wrap items-center justify-between gap-2 lg:col-span-3">
          <div className="flex items-center gap-1 rounded-lg bg-[#090B10] p-1">
            {(['all', 'forming', 'ready'] as const).map((tab) => (
              <button
                key={tab}
                type="button"
                onClick={() => {
                  setStatus(tab);
                  setPage(1);
                }}
                className={`rounded-md px-2.5 py-1.5 text-xs font-medium capitalize transition-colors ${
                  status === tab ? 'bg-[#3B82F6] text-white' : 'text-slate-400 hover:text-white'
                }`}
              >
                {tab}
              </button>
            ))}
          </div>

          <label className="inline-flex cursor-pointer items-center gap-2 text-xs text-slate-300 whitespace-nowrap">
            <input
              type="checkbox"
              checked={openOnly}
              onChange={(e) => {
                setOpenOnly(e.target.checked);
                setPage(1);
              }}
              className="h-4 w-4 rounded border-white/20 bg-[#090B10] accent-[#3B82F6]"
            />
            Open seats
          </label>
        </div>
      </div>

      {/* Results Grid */}
      {isLoading ? (
        <div className="mt-6 grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="h-52 animate-pulse rounded-xl border border-white/[0.06] bg-[#11151E] p-6" />
          ))}
        </div>
      ) : isError ? (
        <div role="alert" className="mt-6 rounded-xl border border-red-500/30 bg-red-500/10 p-6 text-sm text-red-300">
          Failed to load teams. Please verify server connectivity.
        </div>
      ) : teams.length === 0 ? (
        <div className="mt-8 rounded-xl border border-dashed border-white/10 bg-[#11151E] p-12 text-center">
          <Users className="mx-auto h-8 w-8 text-slate-500" />
          <h2 className="mt-3 font-display text-lg font-semibold text-white">
            No matching teams found
          </h2>
          <p className="mt-1 text-sm text-slate-400">
            Adjust your filters or start a new team for this hackathon.
          </p>
          {user && (
            <button
              type="button"
              onClick={() => setCreateOpen(true)}
              className="mt-5 rounded-lg bg-[#3B82F6] px-4 py-2 text-xs font-semibold text-white hover:bg-[#2563EB]"
            >
              Create Team
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="mt-6 grid grid-cols-1 gap-5 md:grid-cols-2 lg:grid-cols-3">
            {teams.map((team) => (
              <article
                key={team.id}
                className="flex flex-col justify-between rounded-xl border border-white/[0.08] bg-[#11151E] p-6 transition-colors hover:border-white/20"
              >
                <div>
                  <div className="flex items-start justify-between gap-3">
                    <h2 className="font-display text-lg font-semibold text-white">
                      {team.name}
                    </h2>
                    {renderStatusLabel(team.status)}
                  </div>

                  <p className="mt-1 text-xs text-slate-400">
                    {team.hackathonName} · Lead: {team.leaderName}
                  </p>

                  <p className="mt-3 line-clamp-2 text-sm leading-relaxed text-slate-300">
                    {team.description || 'Engineering team recruiting builders for this hackathon.'}
                  </p>

                  {team.requiredSkills.length > 0 && (
                    <p className="mt-4 text-xs text-slate-400">
                      Seeking: {team.requiredSkills.join(' · ')}
                    </p>
                  )}
                </div>

                <div className="mt-5 flex items-center justify-between border-t border-white/[0.06] pt-4">
                  <div className="font-mono text-xs tabular-nums">
                    <span className="font-semibold text-white">
                      {team.memberCount} / {team.maxCapacity}
                    </span>{' '}
                    <span className="text-slate-400">
                      ({team.openSeats} {team.openSeats === 1 ? 'seat' : 'seats'} open)
                    </span>
                  </div>

                  <Link
                    to={`/teams/${team.id}`}
                    className="inline-flex items-center gap-1 text-xs font-semibold text-[#3B82F6] hover:text-blue-400 whitespace-nowrap"
                  >
                    Inspect Team
                    <ArrowRight className="h-3.5 w-3.5" />
                  </Link>
                </div>
              </article>
            ))}
          </div>

          {pagination && pagination.totalPages > 1 && (
            <div className="mt-8 flex items-center justify-between border-t border-white/[0.08] pt-5 text-xs text-slate-400">
              <span className="font-mono tabular-nums">
                Page {pagination.page} of {pagination.totalPages} · {pagination.total} teams
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
        </>
      )}

      <CreateTeamModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        hackathons={hackathons}
        defaultHackathonId={hackathonId || undefined}
        onCreated={() => {
          void queryClient.invalidateQueries({ queryKey: ['teams'] });
        }}
      />
    </div>
  );
}
