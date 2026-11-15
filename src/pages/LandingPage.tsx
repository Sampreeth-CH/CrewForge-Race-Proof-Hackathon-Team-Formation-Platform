import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { ArrowRight, Lock, ShieldCheck, Zap, Activity, Layers, Database } from 'lucide-react';
import { api } from '../lib/api';
import heroMeshImg from '../assets/images/hero_architecture_mesh_1794754848882.jpg';

interface OverviewStats {
  totalParticipants: number;
  totalTeams: number;
  totalMemberships: number;
  openSeats: number;
  readyTeams: number;
  auditEvents: number;
}

export function LandingPage() {
  const [heroImgFailed, setHeroImgFailed] = useState(false);

  const { data: stats } = useQuery({
    queryKey: ['analytics', 'overview'],
    queryFn: async () => {
      const res = await api.get<OverviewStats>('/analytics/overview');
      return res.data;
    },
  });

  return (
    <div>
      {/* Hero Split */}
      <section className="border-b border-white/[0.06] bg-[#090B10] py-16 lg:py-24">
        <div className="mx-auto grid max-w-7xl grid-cols-1 items-stretch gap-12 px-4 sm:px-6 lg:grid-cols-12 lg:px-8">
          <div className="flex flex-col justify-center lg:col-span-6">
            <p className="text-xs font-medium tracking-wide text-[#3B82F6]">
              Hack4Hack Crew Hiring Challenge · PS1
            </p>
            <h1 className="mt-4 font-display text-4xl font-bold tracking-tight text-white sm:text-5xl leading-[1.1]">
              Race-proof hackathon team formation at scale.
            </h1>
            <p className="mt-5 max-w-xl text-base leading-relaxed text-slate-300">
              CrewForge prevents over-capacity teams, duplicate hackathon memberships, and concurrent
              join anomalies using PostgreSQL row-level locking, transactional idempotency, and
              real-time discovery streams.
            </p>

            <div className="mt-8 flex flex-wrap items-center gap-4">
              <Link
                to="/racelab"
                className="inline-flex items-center gap-2 rounded-lg bg-[#3B82F6] px-5 py-3 text-sm font-semibold text-white transition-colors hover:bg-[#2563EB] whitespace-nowrap shrink-0"
              >
                Launch 50-User RaceLab
                <ArrowRight className="h-4 w-4" />
              </Link>
              <Link
                to="/teams"
                className="inline-flex items-center gap-2 rounded-lg border border-white/15 bg-[#11151E] px-5 py-3 text-sm font-medium text-slate-100 transition-colors hover:border-white/30 hover:bg-[#161B26] whitespace-nowrap shrink-0"
              >
                Browse Live Teams
              </Link>
            </div>
          </div>

          <div className="lg:col-span-6">
            <div className="relative h-full min-h-[280px] overflow-hidden rounded-xl border border-white/10 bg-[#11151E]">
              {!heroImgFailed ? (
                <img
                  src={heroMeshImg}
                  alt="CrewForge distributed database lock architecture visualization"
                  referrerPolicy="no-referrer"
                  onError={() => setHeroImgFailed(true)}
                  className="h-full w-full object-cover"
                />
              ) : (
                <div className="flex h-full min-h-[300px] flex-col items-center justify-center bg-gradient-to-br from-[#11151E] via-[#131B2E] to-[#090B10] p-8 text-center">
                  <Database className="h-10 w-10 text-[#3B82F6]" />
                  <p className="mt-3 text-sm font-medium text-slate-200">
                    Transactional Row-Lock Mesh
                  </p>
                  <p className="mt-1 text-xs text-slate-400">
                    SELECT FOR UPDATE · UNIQUE (hackathon_id, user_id)
                  </p>
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Full-Width 4-Column Live Metrics Strip Below Hero Split */}
        <div className="mx-auto mt-12 max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="grid grid-cols-2 divide-y divide-white/[0.06] rounded-xl border border-white/[0.08] bg-[#11151E] sm:grid-cols-4 sm:divide-x sm:divide-y-0">
            <div className="p-6">
              <p className="text-xs font-medium text-slate-400">Registered Engineers</p>
              <p className="mt-2 font-mono text-2xl font-semibold text-white tabular-nums">
                {stats ? stats.totalParticipants.toLocaleString() : '—'}
              </p>
            </div>
            <div className="p-6">
              <p className="text-xs font-medium text-slate-400">Active Teams</p>
              <p className="mt-2 font-mono text-2xl font-semibold text-white tabular-nums">
                {stats ? stats.totalTeams.toLocaleString() : '—'}
              </p>
            </div>
            <div className="p-6">
              <p className="text-xs font-medium text-slate-400">Open Team Seats</p>
              <p className="mt-2 font-mono text-2xl font-semibold text-[#3B82F6] tabular-nums">
                {stats ? stats.openSeats.toLocaleString() : '—'}
              </p>
            </div>
            <div className="p-6">
              <p className="text-xs font-medium text-slate-400">Immutable Audit Events</p>
              <p className="mt-2 font-mono text-2xl font-semibold text-white tabular-nums">
                {stats ? stats.auditEvents.toLocaleString() : '—'}
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* Core Architectural Guarantees */}
      <section className="py-16 lg:py-20">
        <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl">
            <h2 className="font-display text-2xl font-semibold text-white sm:text-3xl">
              Correctness enforced in the database, verified under contention.
            </h2>
            <p className="mt-3 text-sm leading-relaxed text-slate-400">
              Client-side checks never protect capacity. Every seat acquisition executes inside an
              ACID PostgreSQL transaction with explicit row locks and database-level invariants.
            </p>
          </div>

          <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-3">
            <div className="rounded-xl border border-white/[0.08] bg-[#11151E] p-6">
              <Lock className="h-5 w-5 text-[#3B82F6]" />
              <h3 className="mt-4 font-display text-base font-semibold text-white">
                01. Row-Level Seat Locking
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">
                Join requests and direct joins acquire <span className="font-mono text-xs text-slate-200">SELECT ... FOR UPDATE</span> on the target team row, backed by a <span className="font-mono text-xs text-slate-200">UNIQUE (hackathon_id, user_id)</span> constraint.
              </p>
            </div>

            <div className="rounded-xl border border-white/[0.08] bg-[#11151E] p-6">
              <ShieldCheck className="h-5 w-5 text-[#6366F1]" />
              <h3 className="mt-4 font-display text-base font-semibold text-white">
                02. Idempotent Mutations & 256-Bit Invites
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">
                All mutations accept <span className="font-mono text-xs text-slate-200">Idempotency-Key</span> headers stored transactionally, rejecting payload mismatches with HTTP 409. Invites store only SHA-256 digests.
              </p>
            </div>

            <div className="rounded-xl border border-white/[0.08] bg-[#11151E] p-6">
              <Activity className="h-5 w-5 text-emerald-400" />
              <h3 className="mt-4 font-display text-base font-semibold text-white">
                03. Commit-Bound Real-Time Discovery
              </h3>
              <p className="mt-2 text-sm leading-relaxed text-slate-400">
                PostgreSQL <span className="font-mono text-xs text-slate-200">pg_notify</span> fires inside the transaction and streams over SSE only after <span className="font-mono text-xs text-slate-200">COMMIT</span> succeeds, eliminating phantom board updates.
              </p>
            </div>
          </div>

          <div className="mt-10 grid grid-cols-1 gap-6 md:grid-cols-2">
            <div className="flex flex-col justify-between rounded-xl border border-white/[0.08] bg-[#11151E] p-6">
              <div>
                <div className="flex items-center gap-2 text-xs font-medium text-[#3B82F6]">
                  <Zap className="h-4 w-4" />
                  <span>Deterministic Matching</span>
                </div>
                <h3 className="mt-3 font-display text-lg font-semibold text-white">
                  70% Skill + 30% Timezone Recommender
                </h3>
                <p className="mt-2 text-sm text-slate-400">
                  Evaluates unallocated participants in the same hackathon against missing team skills
                  and IANA circular timezone overlap without external AI dependencies.
                </p>
              </div>
              <div className="mt-5">
                <Link
                  to="/teams"
                  className="text-xs font-medium text-[#3B82F6] hover:underline"
                >
                  Inspect team recommendations on any team page
                </Link>
              </div>
            </div>

            <div className="flex flex-col justify-between rounded-xl border border-white/[0.08] bg-[#11151E] p-6">
              <div>
                <div className="flex items-center gap-2 text-xs font-medium text-[#6366F1]">
                  <Layers className="h-4 w-4" />
                  <span>Post-Deletion Traceability</span>
                </div>
                <h3 className="mt-3 font-display text-lg font-semibold text-white">
                  Searchable Immutable Audit Explorer
                </h3>
                <p className="mt-2 text-sm text-slate-400">
                  Every team creation, seat claim, leadership transfer, invitation revocation, and team
                  deletion persists independently of cascading deletes.
                </p>
              </div>
              <div className="mt-5">
                <Link
                  to="/audit"
                  className="text-xs font-medium text-[#6366F1] hover:underline"
                >
                  Open Audit Explorer
                </Link>
              </div>
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
