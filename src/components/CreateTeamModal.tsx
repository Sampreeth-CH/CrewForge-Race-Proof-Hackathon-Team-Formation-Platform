import React, { useEffect, useRef, useState } from 'react';
import { X } from 'lucide-react';
import { api, extractApiError, newIdempotencyKey } from '../lib/api';
import { useToast } from '../context/ToastContext';

export interface HackathonSummary {
  id: string;
  name: string;
  minTeamSize: number;
  maxTeamSize: number;
}

interface CreateTeamModalProps {
  open: boolean;
  onClose: () => void;
  hackathons: HackathonSummary[];
  defaultHackathonId?: string;
  onCreated: (teamId: string) => void;
}

export function CreateTeamModal({
  open,
  onClose,
  hackathons,
  defaultHackathonId,
  onCreated,
}: CreateTeamModalProps) {
  const { pushToast } = useToast();
  const [hackathonId, setHackathonId] = useState(defaultHackathonId || hackathons[0]?.id || '');
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [maxCapacity, setMaxCapacity] = useState(4);
  const [skillsText, setSkillsText] = useState('PostgreSQL, TypeScript, React');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const nameInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (!open) return;
    const targetId = defaultHackathonId || hackathons[0]?.id || '';
    setHackathonId(targetId);
    const matched = hackathons.find((h) => h.id === targetId) || hackathons[0];
    if (matched) setMaxCapacity(matched.maxTeamSize);
    setError(null);

    const focusTimer = setTimeout(() => {
      nameInputRef.current?.focus();
    }, 10);

    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape' && !submitting) {
        onClose();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => {
      clearTimeout(focusTimer);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open, defaultHackathonId, hackathons, submitting, onClose]);

  if (!open) return null;

  const selectedHack = hackathons.find((h) => h.id === hackathonId) || hackathons[0];

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      const requiredSkills = skillsText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const res = await api.post<{ team: { id: string; name: string } }>(
        '/teams',
        {
          hackathonId: selectedHack?.id || hackathonId,
          name,
          description,
          maxCapacity: Number(maxCapacity),
          requiredSkills,
        },
        {
          headers: {
            'Idempotency-Key': newIdempotencyKey('create-team'),
          },
        }
      );

      pushToast({
        variant: 'success',
        title: 'Team created',
        description: `${res.data.team.name} is now live on the discovery board.`,
      });
      setName('');
      setDescription('');
      onCreated(res.data.team.id);
      onClose();
    } catch (err) {
      setError(extractApiError(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="create-team-title"
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
    >
      <div className="w-full max-w-lg rounded-xl border border-white/10 bg-[#11151E] p-6 shadow-2xl">
        <div className="flex items-center justify-between border-b border-white/[0.08] pb-4">
          <h2 id="create-team-title" className="text-lg font-semibold text-white">
            Create New Team
          </h2>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close create team modal"
            className="rounded-lg p-1.5 text-slate-400 hover:bg-white/5 hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <form onSubmit={handleSubmit} className="mt-5 space-y-4">
          {error && (
            <div role="alert" className="rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
              {error}
            </div>
          )}

          <div>
            <label htmlFor="team-hackathon" className="block text-xs font-medium text-slate-300">
              Hackathon
            </label>
            <select
              id="team-hackathon"
              value={selectedHack?.id || ''}
              onChange={(e) => {
                const next = hackathons.find((h) => h.id === e.target.value);
                setHackathonId(e.target.value);
                if (next) setMaxCapacity(next.maxTeamSize);
              }}
              className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2.5 text-sm text-white focus:border-[#3B82F6] focus:outline-none"
            >
              {hackathons.map((h) => (
                <option key={h.id} value={h.id}>
                  {h.name} ({h.minTeamSize}–{h.maxTeamSize} members)
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="team-name" className="block text-xs font-medium text-slate-300">
              Team Name
            </label>
            <input
              ref={nameInputRef}
              id="team-name"
              type="text"
              required
              minLength={2}
              maxLength={100}
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Serializable Consensus"
              className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2.5 text-sm text-white placeholder:text-slate-600 focus:border-[#3B82F6] focus:outline-none"
            />
          </div>

          <div>
            <label htmlFor="team-desc" className="block text-xs font-medium text-slate-300">
              Project Focus & Pitch
            </label>
            <textarea
              id="team-desc"
              rows={3}
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Describe what your team is building and who you are looking for..."
              className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2 text-sm text-white placeholder:text-slate-600 focus:border-[#3B82F6] focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            <div>
              <label htmlFor="team-capacity" className="block text-xs font-medium text-slate-300">
                Max Capacity ({selectedHack?.minTeamSize ?? 1}–{selectedHack?.maxTeamSize ?? 10})
              </label>
              <input
                id="team-capacity"
                type="number"
                min={selectedHack?.minTeamSize ?? 1}
                max={selectedHack?.maxTeamSize ?? 10}
                value={maxCapacity}
                onChange={(e) => setMaxCapacity(Number(e.target.value))}
                className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2.5 font-mono text-sm text-white focus:border-[#3B82F6] focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="team-skills" className="block text-xs font-medium text-slate-300">
                Required Skills (comma-separated)
              </label>
              <input
                id="team-skills"
                type="text"
                value={skillsText}
                onChange={(e) => setSkillsText(e.target.value)}
                placeholder="PostgreSQL, Rust, React"
                className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2.5 text-sm text-white placeholder:text-slate-600 focus:border-[#3B82F6] focus:outline-none"
              />
            </div>
          </div>

          <div className="flex items-center justify-end gap-3 pt-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded-lg border border-white/10 px-4 py-2 text-xs font-medium text-slate-300 hover:bg-white/5"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={submitting}
              className="rounded-lg bg-[#3B82F6] px-5 py-2 text-xs font-semibold text-white transition-colors hover:bg-[#2563EB] disabled:opacity-50"
            >
              {submitting ? 'Creating...' : 'Create Team'}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
