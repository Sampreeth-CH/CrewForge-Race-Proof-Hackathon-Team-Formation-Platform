import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Radio, ArrowUpRight, Users, Trophy } from 'lucide-react';
import { api } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useRealtime } from '../context/RealtimeContext';
import { CreateTeamModal, HackathonSummary } from '../components/CreateTeamModal';

interface HackathonItem extends HackathonSummary {
  slug: string;
  description: string;
  registrationStatus: string;
  teamFormationStatus: string;
  teamCount: number;
  participantCount: number;
}

interface OverviewStats {
  totalParticipants: number;
  totalTeams: number;
  totalMemberships: number;
  openSeats: number;
  readyTeams: number;
  auditEvents: number;
}

export function DashboardPage() {
  const { user, memberships } = useAuth();
  const { connected, events } = useRealtime();
  const queryClient = useQueryClient();
  const [createOpen, setCreateOpen] = useState(false);

  const { data: stats, isLoading: statsLoading } = useQuery({
    queryKey: ['analytics', 'overview'],
    queryFn: async () => (await api.get<OverviewStats>('/analytics/overview')).data,
  });

  const { data: hackathonsData, isLoading: hacksLoading } = useQuery({
    queryKey: ['hackathons'],
    queryFn: async () => (await api.get<{ hackathons: HackathonItem[] }>('/hackathons')).data,
  });

  const hackathons = hackathonsData?.hackathons ?? [];

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-col justify-between gap-4 border-b border-white/[0.08] pb-6 sm:flex-row sm:items-center">
        <div>
          <h1 className="font-display text-2xl font-bold text-white sm:text-3xl">
            Engineering Workspace
          </h1>
          <p className="mt-1 text-sm text-slate-400">
            {user
              ? `Signed in as ${user.fullName} · ${user.role} · ${user.timezone}`
              : 'Live hackathon overview and real-time concurrency telemetry.'}
          </p>
        </div>

        <div className="flex items-center gap-3">
          <Link
            to="/racelab"
            className="rounded-lg border border-white/10 bg-[#11151E] px-4 py-2 text-xs font-medium text-slate-200 hover:bg-[#161B26] whitespace-nowrap shrink-0"
          >
            Open RaceLab
          </Link>
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
              Sign In to Form Team
            </Link>
          )}
        </div>
      </div>

      {/* KPI Row */}
      <div className="mt-6 grid grid-cols-2 gap-4 lg:grid-cols-4">
        {[
          { label: 'Active Hackathons', value: hackathons.length },
          { label: 'Teams Forming / Ready', value: stats?.totalTeams ?? 0 },
          { label: 'Available Seats', value: stats?.openSeats ?? 0 },
          { label: 'Audit Trail Records', value: stats?.auditEvents ?? 0 },
        ].map((kpi) => (
          <div key={kpi.label} className="rounded-xl border border-white/[0.08] bg-[#11151E] p-5">
            <p className="text-xs font-medium text-slate-400">{kpi.label}</p>
            {statsLoading ? (
              <div className="mt-2 h-7 w-16 animate-pulse rounded bg-white/10" />
            ) : (
              <p className="mt-2 font-mono text-2xl font-semibold text-white tabular-nums">
                {kpi.value.toLocaleString()}
              </p>
            )}
          </div>
        ))}
      </div>

      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-12">
        {/* Left: Hackathons & Memberships */}
        <div className="space-y-8 lg:col-span-8">
          {user && (
            <section className="rounded-xl border border-white/[0.08] bg-[#11151E] p-6">
              <div className="flex items-center justify-between">
                <h2 className="font-display text-base font-semibold text-white">
                  Your Team Memberships
                </h2>
                <Link to="/teams" className="text-xs font-medium text-[#3B82F6] hover:underline">
                  Find teams
                </Link>
              </div>

              {memberships.length === 0 ? (
                <div className="mt-4 rounded-lg border border-dashed border-white/10 bg-[#090B10] p-6 text-center">
                  <Users className="mx-auto h-6 w-6 text-slate-500" />
                  <p className="mt-2 text-sm font-medium text-slate-200">
                    You have not joined a team yet.
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    Browse open teams or create your own in an active hackathon.
                  </p>
                  <div className="mt-4 flex justify-center gap-3">
                    <Link
                      to="/teams"
                      className="rounded-lg bg-[#3B82F6] px-4 py-2 text-xs font-semibold text-white hover:bg-[#2563EB]"
                    >
                      Browse Discovery Board
                    </Link>
                  </div>
                </div>
              ) : (
                <div className="mt-4 divide-y divide-white/[0.06]">
                  {memberships.map((m) => (
                    <div key={m.teamId} className="flex items-center justify-between py-3.5">
                      <div>
                        <p className="text-sm font-semibold text-white">{m.teamName}</p>
                        <p className="mt-0.5 text-xs text-slate-400">
                          {m.hackathonName} · Role: {m.role}
                        </p>
                      </div>
                      <Link
                        to={`/teams/${m.teamId}`}
                        className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-slate-200 hover:bg-white/5"
                      >
                        Manage
                        <ArrowUpRight className="h-3.5 w-3.5" />
                      </Link>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          <section className="rounded-xl border border-white/[0.08] bg-[#11151E] p-6">
            <h2 className="font-display text-base font-semibold text-white">
              Active Hackathons
            </h2>
            {hacksLoading ? (
              <div className="mt-4 space-y-3">
                <div className="h-20 animate-pulse rounded-lg bg-white/5" />
                <div className="h-20 animate-pulse rounded-lg bg-white/5" />
              </div>
            ) : hackathons.length === 0 ? (
              <p className="mt-4 text-sm text-slate-400">No active hackathons configured.</p>
            ) : (
              <div className="mt-4 space-y-3">
                {hackathons.map((h) => (
                  <div
                    key={h.id}
                    className="flex flex-col justify-between gap-4 rounded-lg border border-white/[0.08] bg-[#090B10] p-4 sm:flex-row sm:items-center"
                  >
                    <div>
                      <div className="flex items-center gap-2">
                        <Trophy className="h-4 w-4 text-[#3B82F6]" />
                        <h3 className="text-sm font-semibold text-white">{h.name}</h3>
                      </div>
                      <p className="mt-1 text-xs text-slate-400">{h.description}</p>
                      <p className="mt-2 font-mono text-xs text-slate-400 tabular-nums">
                        Team size {h.minTeamSize}–{h.maxTeamSize} · {h.teamCount} teams ·{' '}
                        {h.participantCount} members · Formation {h.teamFormationStatus}
                      </p>
                    </div>
                    <Link
                      to={`/teams?hackathonId=${h.id}`}
                      className="rounded-lg border border-white/10 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-white/5 whitespace-nowrap shrink-0"
                    >
                      View Teams
                    </Link>
                  </div>
                ))}
              </div>
            )}
          </section>
        </div>

        {/* Right: Live SSE Stream */}
        <aside className="rounded-xl border border-white/[0.08] bg-[#11151E] p-6 lg:col-span-4">
          <div className="flex items-center justify-between border-b border-white/[0.08] pb-3.5">
            <h2 className="font-display text-base font-semibold text-white">
              Live SSE Event Stream
            </h2>
            <span className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-300">
              <Radio
                className={`h-3.5 w-3.5 ${connected ? 'text-emerald-400' : 'text-amber-400'}`}
              />
              {connected ? 'Connected' : 'Reconnecting'}
            </span>
          </div>

          <p className="mt-3 text-xs text-slate-400">
            Events originate from PostgreSQL <span className="font-mono text-slate-300">pg_notify</span> inside committed transactions.
          </p>

          {events.length === 0 ? (
            <div className="mt-5 rounded-lg border border-dashed border-white/10 bg-[#090B10] p-5 text-center text-xs text-slate-500">
              Listening for live team creations, joins, leadership transfers, and requests.
            </div>
          ) : (
            <ul className="mt-4 space-y-2.5">
              {events.slice(0, 10).map((ev) => (
                <li
                  key={ev.id}
                  className="rounded-lg border border-white/[0.06] bg-[#090B10] p-3 text-xs"
                >
                  <div className="flex items-center justify-between gap-2">
                    <span className="font-mono font-medium text-[#3B82F6]">{ev.type}</span>
                    <span className="font-mono text-[11px] text-slate-500 tabular-nums">
                      {new Date(ev.timestamp).toLocaleTimeString()}
                    </span>
                  </div>
                  <p className="mt-1 truncate font-mono text-[11px] text-slate-400">
                    team:{ev.teamId.slice(0, 8)}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </aside>
      </div>

      <CreateTeamModal
        open={createOpen}
        onClose={() => setCreateOpen(false)}
        hackathons={hackathons}
        onCreated={() => {
          void queryClient.invalidateQueries({ queryKey: ['teams'] });
          void queryClient.invalidateQueries({ queryKey: ['hackathons'] });
          void queryClient.invalidateQueries({ queryKey: ['analytics'] });
        }}
      />
    </div>
  );
}
