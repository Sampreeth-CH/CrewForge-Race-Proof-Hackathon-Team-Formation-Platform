import React, { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeft,
  Check,
  Copy,
  Crown,
  KeyRound,
  ShieldAlert,
  Sparkles,
  Trash2,
  UserMinus,
  UserPlus,
  X,
} from 'lucide-react';
import { api, extractApiError, newIdempotencyKey } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

interface TeamDetailResponse {
  team: {
    id: string;
    hackathonId: string;
    hackathonName: string;
    minTeamSize: number;
    maxTeamSize: number;
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
  };
  members: Array<{
    userId: string;
    fullName: string;
    skills: string[];
    experienceLevel: string;
    timezone: string;
    role: 'leader' | 'member';
    joinedAt: string;
  }>;
  joinRequests: Array<{
    id: string;
    userId: string;
    fullName: string;
    skills: string[];
    experienceLevel: string;
    timezone: string;
    message: string;
    status: string;
    createdAt: string;
  }>;
  invites: Array<{
    id: string;
    codePrefix: string;
    maxUses: number;
    usesCount: number;
    expiresAt: string;
    revokedAt: string | null;
    createdAt: string;
  }>;
}

interface RecommendationItem {
  userId: string;
  candidateName: string;
  experienceLevel: string;
  timezone: string;
  matchingScore: number;
  skillScore: number;
  timezoneScore: number;
  matchingSkills: string[];
  complementarySkills: string[];
  timezoneDiffHours: number;
  explanation: string;
}

export function TeamDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { user, refreshMe } = useAuth();
  const { pushToast } = useToast();

  const [joinMessage, setJoinMessage] = useState('');
  const [inviteCodeInput, setInviteCodeInput] = useState('');
  const [generatedCode, setGeneratedCode] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const { data, isLoading, isError } = useQuery({
    queryKey: ['team', id],
    enabled: Boolean(id),
    queryFn: async () => (await api.get<TeamDetailResponse>(`/teams/${id}`)).data,
  });

  const { data: recData, isLoading: recLoading } = useQuery({
    queryKey: ['team-recommendations', id],
    enabled: Boolean(id),
    queryFn: async () =>
      (await api.get<{ recommendations: RecommendationItem[] }>(`/teams/${id}/recommendations`))
        .data,
  });

  const invalidateAll = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ['team', id] }),
      queryClient.invalidateQueries({ queryKey: ['team-recommendations', id] }),
      queryClient.invalidateQueries({ queryKey: ['teams'] }),
      queryClient.invalidateQueries({ queryKey: ['analytics'] }),
      refreshMe(),
    ]);
  };

  if (isLoading) {
    return (
      <div className="mx-auto max-w-6xl px-4 py-8 sm:px-6 lg:px-8">
        <div className="h-40 animate-pulse rounded-xl bg-[#11151E]" />
      </div>
    );
  }

  if (isError || !data) {
    return (
      <div className="mx-auto max-w-4xl px-4 py-12 text-center">
        <h1 className="font-display text-2xl font-bold text-white">Team not found</h1>
        <p className="mt-2 text-sm text-slate-400">
          This team may have been disbanded after its final member left.
        </p>
        <div className="mt-6 flex justify-center gap-3">
          <Link
            to="/teams"
            className="rounded-lg bg-[#3B82F6] px-4 py-2 text-xs font-semibold text-white"
          >
            Back to Teams
          </Link>
          <Link
            to={`/audit?teamId=${id}`}
            className="rounded-lg border border-white/10 px-4 py-2 text-xs font-medium text-slate-200"
          >
            View Audit Trail
          </Link>
        </div>
      </div>
    );
  }

  const { team, members, joinRequests, invites } = data;
  const isMember = Boolean(user && members.some((m) => m.userId === user.id));
  const isLeader = Boolean(user && (user.id === team.leaderId || user.role === 'admin'));

  const handleDirectJoin = async (code?: string) => {
    setBusy(true);
    try {
      await api.post(
        `/teams/${team.id}/join`,
        code ? { inviteCode: code } : {},
        { headers: { 'Idempotency-Key': newIdempotencyKey('join') } }
      );
      pushToast({ variant: 'success', title: `Joined ${team.name}` });
      setInviteCodeInput('');
      await invalidateAll();
    } catch (err) {
      pushToast({ variant: 'error', title: 'Could not join team', description: extractApiError(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleJoinRequest = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    try {
      await api.post(
        `/teams/${team.id}/join-requests`,
        { message: joinMessage },
        { headers: { 'Idempotency-Key': newIdempotencyKey('jr') } }
      );
      pushToast({ variant: 'success', title: 'Join request submitted' });
      setJoinMessage('');
      await invalidateAll();
    } catch (err) {
      pushToast({ variant: 'error', title: 'Request failed', description: extractApiError(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleAcceptRequest = async (requestId: string) => {
    setBusy(true);
    try {
      await api.post(
        `/teams/${team.id}/join-requests/${requestId}/accept`,
        {},
        { headers: { 'Idempotency-Key': newIdempotencyKey('accept') } }
      );
      pushToast({ variant: 'success', title: 'Join request accepted transactionally' });
      await invalidateAll();
    } catch (err) {
      pushToast({ variant: 'error', title: 'Accept failed', description: extractApiError(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleRejectRequest = async (requestId: string) => {
    setBusy(true);
    try {
      await api.post(
        `/teams/${team.id}/join-requests/${requestId}/reject`,
        {},
        { headers: { 'Idempotency-Key': newIdempotencyKey('reject') } }
      );
      pushToast({ variant: 'info', title: 'Join request rejected' });
      await invalidateAll();
    } catch (err) {
      pushToast({ variant: 'error', title: 'Reject failed', description: extractApiError(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleLeaveTeam = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ deletedTeam: boolean }>(`/teams/${team.id}/leave`);
      pushToast({
        variant: 'info',
        title: res.data.deletedTeam ? 'Team deleted as last member left' : 'Left team',
      });
      await invalidateAll();
      if (res.data.deletedTeam) navigate('/teams');
    } catch (err) {
      pushToast({ variant: 'error', title: 'Leave failed', description: extractApiError(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleRemoveMember = async (targetUserId: string) => {
    setBusy(true);
    try {
      await api.delete(`/teams/${team.id}/members/${targetUserId}`);
      pushToast({ variant: 'info', title: 'Member removed' });
      await invalidateAll();
    } catch (err) {
      pushToast({ variant: 'error', title: 'Remove failed', description: extractApiError(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleTransferLeadership = async (newLeaderId: string) => {
    setBusy(true);
    try {
      await api.post(`/teams/${team.id}/transfer-leadership`, { newLeaderId });
      pushToast({ variant: 'success', title: 'Leadership transferred' });
      await invalidateAll();
    } catch (err) {
      pushToast({ variant: 'error', title: 'Transfer failed', description: extractApiError(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleStatusChange = async (nextStatus: 'forming' | 'ready' | 'locked') => {
    setBusy(true);
    try {
      await api.patch(
        `/teams/${team.id}`,
        { status: nextStatus },
        { headers: { 'Idempotency-Key': newIdempotencyKey('status') } }
      );
      pushToast({ variant: 'success', title: `Team marked ${nextStatus}` });
      await invalidateAll();
    } catch (err) {
      pushToast({ variant: 'error', title: 'Status update rejected', description: extractApiError(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleDeleteTeam = async () => {
    setBusy(true);
    try {
      await api.delete(`/teams/${team.id}`);
      pushToast({ variant: 'info', title: 'Team deleted (audit log retained)' });
      await invalidateAll();
      navigate('/teams');
    } catch (err) {
      pushToast({ variant: 'error', title: 'Delete failed', description: extractApiError(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleGenerateInvite = async () => {
    setBusy(true);
    try {
      const res = await api.post<{ invite: { code: string } }>(`/teams/${team.id}/invites`, {
        expiresInHours: 72,
        maxUses: 10,
      });
      setGeneratedCode(res.data.invite.code);
      pushToast({
        variant: 'success',
        title: '256-bit invitation generated',
        description: 'Copy this code now; only its SHA-256 hash is persisted.',
      });
      await invalidateAll();
    } catch (err) {
      pushToast({ variant: 'error', title: 'Invite failed', description: extractApiError(err) });
    } finally {
      setBusy(false);
    }
  };

  const handleRevokeInvite = async (inviteId: string) => {
    setBusy(true);
    try {
      await api.delete(`/teams/${team.id}/invites/${inviteId}`);
      pushToast({ variant: 'info', title: 'Invitation revoked' });
      await invalidateAll();
    } catch (err) {
      pushToast({ variant: 'error', title: 'Revoke failed', description: extractApiError(err) });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-7xl px-4 py-8 sm:px-6 lg:px-8">
      <Link
        to="/teams"
        className="inline-flex items-center gap-1.5 text-xs font-medium text-slate-400 hover:text-white"
      >
        <ArrowLeft className="h-3.5 w-3.5" />
        Back to Discovery Board
      </Link>

      {/* Header */}
      <div className="mt-4 flex flex-col justify-between gap-4 border-b border-white/[0.08] pb-6 lg:flex-row lg:items-start">
        <div>
          <h1 className="font-display text-2xl font-bold text-white sm:text-3xl">{team.name}</h1>
          <p className="mt-1.5 text-sm text-slate-400">
            {team.hackathonName} · Status: <span className="capitalize text-white">{team.status}</span> ·{' '}
            <span className="font-mono tabular-nums">
              {team.memberCount}/{team.maxCapacity} members
            </span>{' '}
            · Min size {team.minTeamSize}
          </p>
          <p className="mt-3 max-w-3xl text-sm leading-relaxed text-slate-300">
            {team.description || 'No project description provided.'}
          </p>
          {team.requiredSkills.length > 0 && (
            <p className="mt-3 text-xs text-slate-400">
              Required skills: {team.requiredSkills.join(' · ')}
            </p>
          )}
        </div>

        <div className="flex flex-wrap items-center gap-2.5 shrink-0">
          <Link
            to={`/audit?teamId=${team.id}`}
            className="rounded-lg border border-white/10 bg-[#11151E] px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-[#161B26]"
          >
            Team Audit Trail
          </Link>

          {isLeader && (
            <>
              <button
                type="button"
                disabled={busy}
                onClick={() => handleStatusChange(team.status === 'ready' ? 'forming' : 'ready')}
                className="rounded-lg border border-white/10 bg-[#11151E] px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-[#161B26] disabled:opacity-50"
              >
                {team.status === 'ready' ? 'Reopen Forming' : 'Mark Team Ready'}
              </button>
              <button
                type="button"
                disabled={busy}
                onClick={handleDeleteTeam}
                className="inline-flex items-center gap-1.5 rounded-lg border border-red-500/30 bg-red-500/10 px-3.5 py-2 text-xs font-medium text-red-300 hover:bg-red-500/20 disabled:opacity-50"
              >
                <Trash2 className="h-3.5 w-3.5" />
                Delete Team
              </button>
            </>
          )}

          {isMember && (
            <button
              type="button"
              disabled={busy}
              onClick={handleLeaveTeam}
              className="rounded-lg border border-white/15 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-white/5 disabled:opacity-50"
            >
              Leave Team
            </button>
          )}
        </div>
      </div>

      <div className="mt-8 grid grid-cols-1 gap-8 lg:grid-cols-12">
        {/* Left: Roster + Join Actions + Join Requests + Invites */}
        <div className="space-y-8 lg:col-span-7">
          {/* Member Roster */}
          <section className="rounded-xl border border-white/[0.08] bg-[#11151E] p-6">
            <h2 className="font-display text-base font-semibold text-white">
              Active Roster ({members.length}/{team.maxCapacity})
            </h2>
            <div className="mt-4 divide-y divide-white/[0.06]">
              {members.map((m) => (
                <div key={m.userId} className="flex flex-col justify-between gap-3 py-3.5 sm:flex-row sm:items-center">
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-semibold text-white">{m.fullName}</span>
                      {m.role === 'leader' && (
                        <span className="inline-flex items-center gap-1 text-xs font-medium text-amber-400">
                          <Crown className="h-3.5 w-3.5" />
                          Leader
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-slate-400">
                      {m.experienceLevel} · {m.timezone} ·{' '}
                      {m.skills.length > 0 ? m.skills.join(', ') : 'Generalist'}
                    </p>
                  </div>

                  {isLeader && m.userId !== team.leaderId && (
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleTransferLeadership(m.userId)}
                        className="rounded-lg border border-white/10 px-2.5 py-1.5 text-xs text-slate-300 hover:bg-white/5"
                      >
                        Make Leader
                      </button>
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => handleRemoveMember(m.userId)}
                        aria-label={`Remove ${m.fullName}`}
                        className="inline-flex items-center gap-1 rounded-lg border border-red-500/20 px-2.5 py-1.5 text-xs text-red-300 hover:bg-red-500/10"
                      >
                        <UserMinus className="h-3.5 w-3.5" />
                        Remove
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>

          {/* Non-member Join Controls */}
          {!isMember && (
            <section className="rounded-xl border border-white/[0.08] bg-[#11151E] p-6">
              <h2 className="font-display text-base font-semibold text-white">
                Join This Team
              </h2>
              {!user ? (
                <div className="mt-3">
                  <p className="text-xs text-slate-400">
                    Sign in to join directly, redeem an invitation code, or submit a join request.
                  </p>
                  <Link
                    to="/login"
                    className="mt-3 inline-block rounded-lg bg-[#3B82F6] px-4 py-2 text-xs font-semibold text-white"
                  >
                    Sign In
                  </Link>
                </div>
              ) : (
                <div className="mt-4 space-y-5">
                  <div className="flex flex-wrap items-center gap-3">
                    <button
                      type="button"
                      disabled={busy || team.openSeats <= 0 || team.status === 'locked'}
                      onClick={() => handleDirectJoin()}
                      className="inline-flex items-center gap-1.5 rounded-lg bg-[#3B82F6] px-4 py-2 text-xs font-semibold text-white hover:bg-[#2563EB] disabled:opacity-40"
                    >
                      <UserPlus className="h-3.5 w-3.5" />
                      {team.openSeats <= 0 ? 'Team At Capacity' : 'Claim Open Seat'}
                    </button>
                  </div>

                  <form
                    onSubmit={(e) => {
                      e.preventDefault();
                      if (inviteCodeInput.trim()) void handleDirectJoin(inviteCodeInput.trim());
                    }}
                    className="flex flex-col gap-2 border-t border-white/[0.06] pt-4 sm:flex-row"
                  >
                    <label htmlFor="invite-code-input" className="sr-only">
                      Invitation Code
                    </label>
                    <input
                      id="invite-code-input"
                      type="text"
                      value={inviteCodeInput}
                      onChange={(e) => setInviteCodeInput(e.target.value)}
                      placeholder="Paste cf_... invitation code"
                      className="flex-1 rounded-lg border border-white/10 bg-[#090B10] px-3 py-2 font-mono text-xs text-white focus:border-[#3B82F6] focus:outline-none"
                    />
                    <button
                      type="submit"
                      disabled={busy || !inviteCodeInput.trim()}
                      className="rounded-lg border border-white/15 px-4 py-2 text-xs font-medium text-white hover:bg-white/5 disabled:opacity-40"
                    >
                      Redeem Invite
                    </button>
                  </form>

                  <form
                    onSubmit={handleJoinRequest}
                    className="space-y-3 border-t border-white/[0.06] pt-4"
                  >
                    <label htmlFor="join-request-msg" className="block text-xs font-medium text-slate-300">
                      Or Request Leader Approval
                    </label>
                    <textarea
                      id="join-request-msg"
                      rows={2}
                      value={joinMessage}
                      onChange={(e) => setJoinMessage(e.target.value)}
                      placeholder="Share how your skills complement the team..."
                      className="w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2 text-sm text-white focus:border-[#3B82F6] focus:outline-none"
                    />
                    <button
                      type="submit"
                      disabled={busy}
                      className="rounded-lg border border-white/15 px-4 py-2 text-xs font-medium text-slate-100 hover:bg-white/5 disabled:opacity-50"
                    >
                      Submit Join Request
                    </button>
                  </form>
                </div>
              )}
            </section>
          )}

          {/* Leader: Pending Join Requests & Secure 256-Bit Invites */}
          {isLeader && (
            <>
              <section className="rounded-xl border border-white/[0.08] bg-[#11151E] p-6">
                <h2 className="font-display text-base font-semibold text-white">
                  Pending Join Requests ({joinRequests.length})
                </h2>
                {joinRequests.length === 0 ? (
                  <p className="mt-3 text-xs text-slate-400">
                    No pending join requests right now.
                  </p>
                ) : (
                  <div className="mt-4 divide-y divide-white/[0.06]">
                    {joinRequests.map((jr) => (
                      <div key={jr.id} className="flex flex-col justify-between gap-3 py-3.5 sm:flex-row sm:items-center">
                        <div>
                          <p className="text-sm font-semibold text-white">{jr.fullName}</p>
                          <p className="mt-0.5 text-xs text-slate-400">
                            {jr.experienceLevel} · {jr.timezone} · {jr.skills.join(', ')}
                          </p>
                          {jr.message && (
                            <p className="mt-1.5 text-xs text-slate-300">"{jr.message}"</p>
                          )}
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => handleAcceptRequest(jr.id)}
                            className="inline-flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-semibold text-white hover:bg-emerald-500 disabled:opacity-50"
                          >
                            <Check className="h-3.5 w-3.5" />
                            Accept
                          </button>
                          <button
                            type="button"
                            disabled={busy}
                            onClick={() => handleRejectRequest(jr.id)}
                            className="inline-flex items-center gap-1 rounded-lg border border-white/10 px-3 py-1.5 text-xs font-medium text-slate-300 hover:bg-white/5 disabled:opacity-50"
                          >
                            <X className="h-3.5 w-3.5" />
                            Reject
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </section>

              <section className="rounded-xl border border-white/[0.08] bg-[#11151E] p-6">
                <div className="flex items-center justify-between">
                  <div>
                    <h2 className="font-display text-base font-semibold text-white">
                      256-Bit Cryptographic Invites
                    </h2>
                    <p className="mt-0.5 text-xs text-slate-400">
                      Tokens use 32 random bytes; only SHA-256 digests are persisted.
                    </p>
                  </div>
                  <button
                    type="button"
                    disabled={busy}
                    onClick={handleGenerateInvite}
                    className="inline-flex items-center gap-1.5 rounded-lg bg-[#3B82F6] px-3.5 py-2 text-xs font-semibold text-white hover:bg-[#2563EB]"
                  >
                    <KeyRound className="h-3.5 w-3.5" />
                    Generate Invite
                  </button>
                </div>

                {generatedCode && (
                  <div className="mt-4 flex items-center justify-between gap-3 rounded-lg border border-emerald-500/30 bg-emerald-500/10 p-3">
                    <code className="truncate font-mono text-xs text-emerald-200">
                      {generatedCode}
                    </code>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard.writeText(generatedCode);
                        pushToast({ variant: 'success', title: 'Invite code copied' });
                      }}
                      aria-label="Copy invite code"
                      className="inline-flex items-center gap-1 rounded border border-emerald-400/30 px-2.5 py-1 text-xs text-emerald-200 hover:bg-emerald-500/20"
                    >
                      <Copy className="h-3 w-3" />
                      Copy
                    </button>
                  </div>
                )}

                {invites.length > 0 && (
                  <div className="mt-4 divide-y divide-white/[0.06]">
                    {invites.map((inv) => {
                      const isRevoked = Boolean(inv.revokedAt);
                      const isExpired = new Date(inv.expiresAt).getTime() <= Date.now();
                      return (
                        <div key={inv.id} className="flex items-center justify-between py-2.5 text-xs">
                          <div>
                            <span className="font-mono text-slate-200">{inv.codePrefix}...</span>
                            <span className="ml-2 text-slate-400 tabular-nums">
                              {inv.usesCount}/{inv.maxUses} uses ·{' '}
                              {isRevoked ? 'Revoked' : isExpired ? 'Expired' : 'Active'}
                            </span>
                          </div>
                          {!isRevoked && (
                            <button
                              type="button"
                              disabled={busy}
                              onClick={() => handleRevokeInvite(inv.id)}
                              className="inline-flex items-center gap-1 text-xs text-red-300 hover:underline"
                            >
                              <ShieldAlert className="h-3.5 w-3.5" />
                              Revoke
                            </button>
                          )}
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </>
          )}
        </div>

        {/* Right: Deterministic Teammate Recommendation Engine */}
        <aside className="rounded-xl border border-white/[0.08] bg-[#11151E] p-6 lg:col-span-5">
          <div className="flex items-center gap-2 border-b border-white/[0.08] pb-3.5">
            <Sparkles className="h-4 w-4 text-[#6366F1]" />
            <h2 className="font-display text-base font-semibold text-white">
              Teammate Recommendations
            </h2>
          </div>
          <p className="mt-2.5 text-xs text-slate-400">
            Deterministic score: 70% missing skill compatibility + 30% IANA timezone alignment.
            Excludes users already committed to a team in this hackathon.
          </p>

          {recLoading ? (
            <div className="mt-4 space-y-3">
              <div className="h-24 animate-pulse rounded-lg bg-white/5" />
              <div className="h-24 animate-pulse rounded-lg bg-white/5" />
            </div>
          ) : (recData?.recommendations ?? []).length === 0 ? (
            <p className="mt-5 text-xs text-slate-400">
              No unallocated candidates available in this hackathon yet.
            </p>
          ) : (
            <div className="mt-4 space-y-3">
              {(recData?.recommendations ?? []).map((rec) => (
                <div
                  key={rec.userId}
                  className="rounded-lg border border-white/[0.08] bg-[#090B10] p-4"
                >
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-sm font-semibold text-white">{rec.candidateName}</p>
                    <span className="font-mono text-sm font-semibold text-[#3B82F6] tabular-nums">
                      {rec.matchingScore}/100
                    </span>
                  </div>
                  <p className="mt-1 font-mono text-[11px] text-slate-400 tabular-nums">
                    {rec.experienceLevel} · {rec.timezone} ({rec.timezoneDiffHours}h offset)
                  </p>
                  {rec.complementarySkills.length > 0 && (
                    <p className="mt-2 text-xs text-emerald-300">
                      Complementary: {rec.complementarySkills.join(', ')}
                    </p>
                  )}
                  <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
                    {rec.explanation}
                  </p>
                </div>
              ))}
            </div>
          )}
        </aside>
      </div>
    </div>
  );
}
