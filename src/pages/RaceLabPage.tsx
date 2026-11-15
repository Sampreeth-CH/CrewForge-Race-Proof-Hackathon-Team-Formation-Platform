import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { CheckCircle2, Play, ShieldCheck, AlertTriangle, Lock, XCircle } from 'lucide-react';
import { API_BASE, api, extractApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

interface CompetitorResult {
  index: number;
  name: string;
  userId: string;
  status: 'pending' | 'running' | 'won' | 'capacity_rejected' | 'duplicate_rejected' | 'error';
  httpStatus?: number;
  errorCode?: string;
  durationMs?: number;
}

interface VerifyResponse {
  teamId: string;
  storedMemberCount: number;
  actualMemberCount: number;
  maxCapacity: number;
  duplicateMemberships: number;
  membershipAuditRecords: number;
  members: Array<{ userId: string; fullName: string; role: string; joinedAt: string }>;
  assertions: {
    exactExpectedSeatsFilled: boolean;
    noCapacityViolation: boolean;
    denormalizedCountMatchesActual: boolean;
    noDuplicateMemberships: boolean;
    auditRecordsRecorded: boolean;
  };
  allPassed: boolean;
}

export function RaceLabPage() {
  const { user, login } = useAuth();
  const { pushToast } = useToast();

  const [selectedHackathonId, setSelectedHackathonId] = useState('');
  const [selectedTeamId, setSelectedTeamId] = useState('');
  const [availableSeats, setAvailableSeats] = useState(1);
  const [competitorCount, setCompetitorCount] = useState(50);
  const [running, setRunning] = useState(false);
  const [results, setResults] = useState<CompetitorResult[]>([]);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [verification, setVerification] = useState<VerifyResponse | null>(null);
  const [maxObservedCount, setMaxObservedCount] = useState<number | null>(null);

  const { data: sandboxData } = useQuery({
    queryKey: ['racelab-targets'],
    queryFn: async () => {
      const [hacksRes, teamsRes] = await Promise.all([
        api.get<{ hackathons: Array<{ id: string; name: string; isDemoSandbox: boolean }> }>(
          '/hackathons?includeSandbox=true'
        ),
        api.get<{
          teams: Array<{ id: string; name: string; hackathonId: string; isDemoSandbox: boolean }>;
        }>('/teams?includeSandbox=true&sandboxOnly=true&limit=50'),
      ]);
      const sandboxHacks = hacksRes.data.hackathons.filter((h) => h.isDemoSandbox);
      const sandboxTeams = teamsRes.data.teams.filter((t) => t.isDemoSandbox);
      return { sandboxHacks, sandboxTeams };
    },
  });

  useEffect(() => {
    if (!sandboxData) return;
    if (!selectedHackathonId && sandboxData.sandboxHacks[0]) {
      setSelectedHackathonId(sandboxData.sandboxHacks[0].id);
    }
    if (!selectedTeamId && sandboxData.sandboxTeams[0]) {
      setSelectedTeamId(sandboxData.sandboxTeams[0].id);
    }
  }, [sandboxData, selectedHackathonId, selectedTeamId]);

  const isAuthorized = user && (user.role === 'admin' || user.role === 'organizer');

  const authorizeAsDemoAdmin = async () => {
    try {
      await login('elena@crewforge.dev', 'CrewForgeDemo!2026');
      pushToast({ variant: 'success', title: 'Authorized as RaceLab Admin (Elena Rostova)' });
    } catch (err) {
      pushToast({ variant: 'error', title: 'Authorization failed', description: extractApiError(err) });
    }
  };

  const launchExperiment = async () => {
    setRunning(true);
    setVerification(null);
    setElapsedMs(null);
    setMaxObservedCount(null);

    try {
      // 1. Setup isolated RaceLab sandbox team & 50 real competitor JWTs on server
      const setupRes = await api.post<{
        hackathonId: string;
        team: { id: string; name: string; memberCount: number; maxCapacity: number };
        competitors: Array<{ id: string; fullName: string; token: string }>;
      }>('/racelab/setup', {
        hackathonId: selectedHackathonId || undefined,
        teamId: selectedTeamId || undefined,
        availableSeats,
        competitorCount,
      });

      const targetTeam = setupRes.data.team;
      const competitors = setupRes.data.competitors;

      const initialNodes: CompetitorResult[] = competitors.map((c, idx) => ({
        index: idx + 1,
        name: c.fullName,
        userId: c.id,
        status: 'running',
      }));
      setResults(initialNodes);

      const startedAt = performance.now();
      let observedMax = targetTeam.memberCount;

      // 2. Fire N genuine concurrent HTTP POST requests using Promise.all
      await Promise.all(
        competitors.map(async (comp, idx) => {
          const reqStart = performance.now();
          try {
            const resp = await fetch(`${API_BASE}/teams/${targetTeam.id}/join`, {
              method: 'POST',
              credentials: 'omit',
              headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${comp.token}`,
              },
              body: JSON.stringify({}),
            });
            const reqDuration = Math.round(performance.now() - reqStart);
            const body = (await resp.json().catch(() => ({}))) as {
              team?: { member_count?: number };
              error?: { code?: string };
            };

            if (resp.ok) {
              if (body.team?.member_count && body.team.member_count > observedMax) {
                observedMax = body.team.member_count;
              }
              setResults((prev) =>
                prev.map((item, i) =>
                  i === idx
                    ? { ...item, status: 'won', httpStatus: resp.status, durationMs: reqDuration }
                    : item
                )
              );
            } else {
              const code = body.error?.code || 'REJECTED';
              const mappedStatus =
                code === 'ALREADY_IN_TEAM'
                  ? 'duplicate_rejected'
                  : resp.status >= 500
                    ? 'error'
                    : 'capacity_rejected';
              setResults((prev) =>
                prev.map((item, i) =>
                  i === idx
                    ? {
                        ...item,
                        status: mappedStatus,
                        httpStatus: resp.status,
                        errorCode: code,
                        durationMs: reqDuration,
                      }
                    : item
                )
              );
            }
          } catch {
            setResults((prev) =>
              prev.map((item, i) =>
                i === idx ? { ...item, status: 'error', httpStatus: 500, errorCode: 'NETWORK' } : item
              )
            );
          }
        })
      );

      setElapsedMs(Math.round(performance.now() - startedAt));

      // 3. Execute live PostgreSQL verification queries against the target team
      const verifyRes = await api.post<VerifyResponse>(`/racelab/verify/${targetTeam.id}`, {
        expectedWinners: availableSeats,
        initialMemberCount: 1,
      });
      setVerification(verifyRes.data);
      setMaxObservedCount(Math.max(observedMax, verifyRes.data.actualMemberCount));
    } catch (err) {
      pushToast({
        variant: 'error',
        title: 'RaceLab experiment failed',
        description: extractApiError(err),
      });
    } finally {
      setRunning(false);
    }
  };

  const completedCount = results.filter((r) => r.status !== 'running' && r.status !== 'pending').length;
  const winnersCount = results.filter((r) => r.status === 'won').length;
  const capacityRejectCount = results.filter((r) => r.status === 'capacity_rejected').length;
  const duplicateRejectCount = results.filter((r) => r.status === 'duplicate_rejected').length;
  const serverErrorCount = results.filter((r) => r.status === 'error').length;

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex flex-col justify-between gap-4 border-b border-white/[0.08] pb-6 lg:flex-row lg:items-end">
        <div>
          <p className="text-xs font-medium text-[#3B82F6]">
            Signature Concurrency Verification Harness
          </p>
          <h1 className="mt-1 font-display text-2xl font-bold text-white sm:text-3xl">
            RaceLab — 50-Request Seat Contention Test
          </h1>
          <p className="mt-2 max-w-2xl text-sm text-slate-400">
            Executes genuine concurrent HTTP requests from isolated synthetic accounts against a
            dedicated sandbox team protected by PostgreSQL <span className="font-mono text-slate-200">SELECT ... FOR UPDATE</span>.
          </p>
        </div>

        {!isAuthorized ? (
          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={authorizeAsDemoAdmin}
              className="rounded-lg bg-[#3B82F6] px-4 py-2.5 text-xs font-semibold text-white hover:bg-[#2563EB] whitespace-nowrap"
            >
              Authorize Sandbox as Admin
            </button>
            <Link
              to="/login"
              className="rounded-lg border border-white/15 px-4 py-2.5 text-xs font-medium text-slate-200 hover:bg-white/5 whitespace-nowrap"
            >
              Sign In Manually
            </Link>
          </div>
        ) : (
          <button
            type="button"
            disabled={running}
            onClick={launchExperiment}
            className="inline-flex items-center gap-2 rounded-lg bg-[#3B82F6] px-5 py-2.5 text-xs font-semibold text-white transition-colors hover:bg-[#2563EB] disabled:opacity-50 whitespace-nowrap shrink-0"
          >
            <Play className="h-4 w-4" />
            {running ? 'Running Concurrent Attack...' : 'Launch Concurrency Experiment'}
          </button>
        )}
      </div>

      {/* Control Panel & Summary Telemetry */}
      <div className="mt-6 grid grid-cols-1 gap-6 lg:grid-cols-12">
        <div className="rounded-xl border border-white/[0.08] bg-[#11151E] p-6 lg:col-span-4">
          <h2 className="font-display text-base font-semibold text-white">
            Experiment Parameters
          </h2>
          <p className="mt-1 text-xs text-slate-400">
            Isolated sandbox team resets cleanly before each run without touching production teams.
          </p>

          <div className="mt-5 space-y-4">
            {sandboxData && sandboxData.sandboxHacks.length > 0 && (
              <div>
                <label htmlFor="racelab-hackathon" className="block text-xs font-medium text-slate-300">
                  Sandbox Hackathon
                </label>
                <select
                  id="racelab-hackathon"
                  disabled={running}
                  value={selectedHackathonId}
                  onChange={(e) => setSelectedHackathonId(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2 text-xs text-white focus:border-[#3B82F6] focus:outline-none"
                >
                  {sandboxData.sandboxHacks.map((h) => (
                    <option key={h.id} value={h.id}>
                      {h.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            {sandboxData && sandboxData.sandboxTeams.length > 0 && (
              <div>
                <label htmlFor="racelab-team" className="block text-xs font-medium text-slate-300">
                  Target Sandbox Team
                </label>
                <select
                  id="racelab-team"
                  disabled={running}
                  value={selectedTeamId}
                  onChange={(e) => setSelectedTeamId(e.target.value)}
                  className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2 text-xs text-white focus:border-[#3B82F6] focus:outline-none"
                >
                  {sandboxData.sandboxTeams.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </div>
            )}

            <div>
              <label htmlFor="racelab-seats" className="block text-xs font-medium text-slate-300">
                Available Open Seats
              </label>
              <input
                id="racelab-seats"
                type="number"
                min={1}
                max={5}
                disabled={running}
                value={availableSeats}
                onChange={(e) => setAvailableSeats(Math.max(1, Math.min(5, Number(e.target.value))))}
                className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2 font-mono text-sm text-white focus:border-[#3B82F6] focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="racelab-competitors" className="block text-xs font-medium text-slate-300">
                Simultaneous Competing Users
              </label>
              <input
                id="racelab-competitors"
                type="number"
                min={2}
                max={60}
                disabled={running}
                value={competitorCount}
                onChange={(e) =>
                  setCompetitorCount(Math.max(2, Math.min(60, Number(e.target.value))))
                }
                className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2 font-mono text-sm text-white focus:border-[#3B82F6] focus:outline-none"
              />
            </div>
          </div>

          <div className="mt-6 border-t border-white/[0.08] pt-4 text-xs text-slate-400 space-y-2">
            <div className="flex items-center gap-2 text-slate-200 font-medium">
              <Lock className="h-3.5 w-3.5 text-[#3B82F6]" />
              <span>PostgreSQL Execution Flow</span>
            </div>
            <p className="leading-relaxed">
              1. Each HTTP request opens an ACID transaction and attempts <code className="font-mono text-slate-200">SELECT * FROM teams WHERE id = $1 FOR UPDATE</code>.
            </p>
            <p className="leading-relaxed">
              2. PostgreSQL serializes competing writers on that team row lock—only the first {availableSeats} transaction(s) see <code className="font-mono text-slate-200">member_count &lt; max_capacity</code>.
            </p>
            <p className="leading-relaxed">
              3. Remaining transactions observe the committed increment, fail the capacity check, roll back, and return <code className="font-mono text-slate-200">409 TEAM_AT_CAPACITY</code>.
            </p>
          </div>
        </div>

        {/* Metrics & 50-Request Live Grid */}
        <div className="space-y-6 lg:col-span-8">
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {[
              { label: 'Requests Fired', value: results.length || competitorCount },
              { label: 'Completed', value: completedCount },
              { label: 'Winners (200 OK)', value: winnersCount, accent: 'text-emerald-400' },
              { label: 'Capacity Rejects (409)', value: capacityRejectCount, accent: 'text-amber-400' },
              { label: 'Duplicate Rejects', value: duplicateRejectCount },
              { label: 'Server Errors (5xx)', value: serverErrorCount, accent: serverErrorCount > 0 ? 'text-red-400' : 'text-white' },
              { label: 'Total Execution', value: elapsedMs !== null ? `${elapsedMs} ms` : '—' },
              { label: 'Max Observed Count', value: maxObservedCount !== null ? `${maxObservedCount}/${1 + availableSeats}` : '—' },
            ].map((m) => (
              <div key={m.label} className="rounded-xl border border-white/[0.08] bg-[#11151E] p-4">
                <p className="text-[11px] font-medium text-slate-400">{m.label}</p>
                <p className={`mt-1.5 font-mono text-xl font-semibold tabular-nums ${m.accent || 'text-white'}`}>
                  {m.value}
                </p>
              </div>
            ))}
          </div>

          {/* 50 Request Indicators */}
          <div className="rounded-xl border border-white/[0.08] bg-[#11151E] p-6">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="font-display text-base font-semibold text-white">
                Concurrent Request Matrix
              </h2>
              <p className="text-xs text-slate-400">
                Green = Seat Acquired · Slate/Amber = 409 Rejected Safely · Red = Error
              </p>
            </div>

            {results.length === 0 ? (
              <div className="mt-5 rounded-lg border border-dashed border-white/10 bg-[#090B10] p-8 text-center text-xs text-slate-400">
                Click &ldquo;Launch Concurrency Experiment&rdquo; to fire {competitorCount} parallel HTTP requests for {availableSeats} open seat(s).
              </div>
            ) : (
              <div
                data-testid="racelab-matrix"
                className="mt-4 grid grid-cols-5 gap-2 sm:grid-cols-10"
              >
                {results.map((r) => {
                  const base =
                    r.status === 'won'
                      ? 'border-emerald-400/60 bg-emerald-500/20 text-emerald-200'
                      : r.status === 'error'
                        ? 'border-red-500/50 bg-red-500/15 text-red-200'
                        : r.status === 'running'
                          ? 'border-[#3B82F6]/40 bg-[#3B82F6]/10 text-blue-200'
                          : 'border-white/10 bg-[#090B10] text-slate-400';

                  return (
                    <div
                      key={r.userId}
                      title={`${r.name}: ${r.httpStatus ?? 'pending'} ${r.errorCode ?? ''}`}
                      className={`rounded-lg border p-2 text-center font-mono text-[11px] tabular-nums ${base}`}
                    >
                      <div className="font-semibold">#{String(r.index).padStart(2, '0')}</div>
                      <div className="mt-0.5 text-[10px]">
                        {r.status === 'won'
                          ? 'WON'
                          : r.status === 'running'
                            ? '...'
                            : r.httpStatus || 'ERR'}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Post-Experiment PostgreSQL Consistency Assertions */}
          {verification && (
            <div
              data-testid="racelab-verification"
              className="rounded-xl border border-white/[0.08] bg-[#11151E] p-6"
            >
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-2">
                  {verification.allPassed ? (
                    <ShieldCheck className="h-5 w-5 text-emerald-400" />
                  ) : (
                    <AlertTriangle className="h-5 w-5 text-red-400" />
                  )}
                  <h2 className="font-display text-base font-semibold text-white">
                    Post-Run PostgreSQL Consistency Verification
                  </h2>
                </div>
                <span
                  className={`font-mono text-xs font-semibold ${
                    verification.allPassed ? 'text-emerald-400' : 'text-red-400'
                  }`}
                >
                  {verification.allPassed ? 'ALL INVARIANTS PASSED' : 'INVARIANT FAILURE'}
                </span>
              </div>

              <div className="mt-4 grid grid-cols-1 gap-2.5 sm:grid-cols-2">
                {[
                  {
                    label: `Exactly ${availableSeats} seat(s) filled`,
                    ok: verification.assertions.exactExpectedSeatsFilled,
                  },
                  {
                    label: 'Zero team capacity violations',
                    ok: verification.assertions.noCapacityViolation,
                  },
                  {
                    label: `member_count (${verification.storedMemberCount}) matches COUNT(*) (${verification.actualMemberCount})`,
                    ok: verification.assertions.denormalizedCountMatchesActual,
                  },
                  {
                    label: 'Zero duplicate hackathon memberships',
                    ok: verification.assertions.noDuplicateMemberships,
                  },
                  {
                    label: `Audit trail persisted (${verification.membershipAuditRecords} join events)`,
                    ok: verification.assertions.auditRecordsRecorded,
                  },
                ].map((check) => (
                  <div
                    key={check.label}
                    className="flex items-center gap-2.5 rounded-lg border border-white/[0.06] bg-[#090B10] px-3.5 py-2.5 text-xs"
                  >
                    {check.ok ? (
                      <CheckCircle2 className="h-4 w-4 shrink-0 text-emerald-400" />
                    ) : (
                      <XCircle className="h-4 w-4 shrink-0 text-red-400" />
                    )}
                    <span className="text-slate-200">{check.label}</span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
