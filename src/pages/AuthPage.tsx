import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';
import { extractApiError } from '../lib/api';

const DEMO_ACCOUNTS = [
  {
    label: 'Participant (Maya Lin)',
    email: 'maya@crewforge.dev',
    role: 'Team Leader · Distributed Systems',
  },
  {
    label: 'Organizer (Arjun Mehta)',
    email: 'arjun@crewforge.dev',
    role: 'Hackathon Manager · RaceLab Access',
  },
  {
    label: 'Admin (Elena Rostova)',
    email: 'elena@crewforge.dev',
    role: 'Platform Admin · Full RaceLab Control',
  },
];

export function AuthPage({ defaultMode = 'login' }: { defaultMode?: 'login' | 'register' }) {
  const [mode, setMode] = useState<'login' | 'register'>(defaultMode);
  const { login, register, loginWithGoogle } = useAuth();
  const { pushToast } = useToast();
  const navigate = useNavigate();

  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [bio, setBio] = useState('');
  const [skillsText, setSkillsText] = useState('PostgreSQL, TypeScript, React');
  const [experienceLevel, setExperienceLevel] = useState('intermediate');
  const [timezone, setTimezone] = useState(
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC'
  );
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSubmitting(true);
    try {
      if (mode === 'login') {
        await login(email, password);
        pushToast({ variant: 'success', title: 'Signed in to CrewForge' });
      } else {
        const skills = skillsText
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean);
        await register({
          fullName,
          email,
          password,
          bio,
          skills,
          experienceLevel,
          timezone,
        });
        pushToast({ variant: 'success', title: 'Account created' });
      }
      navigate('/dashboard');
    } catch (err) {
      setError(extractApiError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleQuickDemo = async (demoEmail: string) => {
    setError(null);
    setSubmitting(true);
    try {
      await login(demoEmail, 'CrewForgeDemo!2026');
      pushToast({ variant: 'success', title: `Signed in as ${demoEmail}` });
      navigate('/dashboard');
    } catch (err) {
      setError(extractApiError(err));
    } finally {
      setSubmitting(false);
    }
  };

  const handleGoogleLogin = async () => {
    setError(null);
    setSubmitting(true);
    try {
      await loginWithGoogle();
      pushToast({ variant: 'success', title: 'Signed in with Google' });
      navigate('/dashboard');
    } catch (err) {
      setError(extractApiError(err));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-12 sm:px-6 lg:px-8">
      <div className="grid grid-cols-1 gap-8 lg:grid-cols-12">
        <div className="rounded-xl border border-white/[0.08] bg-[#11151E] p-6 sm:p-8 lg:col-span-7">
          <div className="flex items-center gap-2 rounded-lg bg-[#090B10] p-1">
            <button
              type="button"
              onClick={() => {
                setMode('login');
                setError(null);
              }}
              className={`flex-1 rounded-md py-2 text-xs font-semibold transition-colors ${
                mode === 'login' ? 'bg-[#3B82F6] text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              Sign In
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('register');
                setError(null);
              }}
              className={`flex-1 rounded-md py-2 text-xs font-semibold transition-colors ${
                mode === 'register' ? 'bg-[#3B82F6] text-white' : 'text-slate-400 hover:text-white'
              }`}
            >
              Create Account
            </button>
          </div>

          <h1 className="mt-6 font-display text-2xl font-bold text-white">
            {mode === 'login' ? 'Sign in to CrewForge' : 'Register engineering profile'}
          </h1>
          <p className="mt-1.5 text-sm text-slate-400">
            {mode === 'login'
              ? 'Authenticate using an HTTP-only session cookie.'
              : 'Create your participant record with skills and IANA timezone for matching.'}
          </p>

          {error && (
            <div role="alert" className="mt-4 rounded-lg border border-red-500/30 bg-red-500/10 p-3 text-xs text-red-300">
              {error}
            </div>
          )}

          <form onSubmit={handleSubmit} className="mt-6 space-y-4">
            {mode === 'register' && (
              <div>
                <label htmlFor="auth-fullname" className="block text-xs font-medium text-slate-300">
                  Full Name
                </label>
                <input
                  id="auth-fullname"
                  type="text"
                  required
                  minLength={2}
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="Ada Lovelace"
                  className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2.5 text-sm text-white focus:border-[#3B82F6] focus:outline-none"
                />
              </div>
            )}

            <div>
              <label htmlFor="auth-email" className="block text-xs font-medium text-slate-300">
                Email Address
              </label>
              <input
                id="auth-email"
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="engineer@company.dev"
                className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2.5 text-sm text-white focus:border-[#3B82F6] focus:outline-none"
              />
            </div>

            <div>
              <label htmlFor="auth-password" className="block text-xs font-medium text-slate-300">
                Password
              </label>
              <input
                id="auth-password"
                type="password"
                required
                minLength={8}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="Minimum 8 characters"
                className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2.5 text-sm text-white focus:border-[#3B82F6] focus:outline-none"
              />
            </div>

            {mode === 'register' && (
              <>
                <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
                  <div>
                    <label htmlFor="auth-exp" className="block text-xs font-medium text-slate-300">
                      Experience Level
                    </label>
                    <select
                      id="auth-exp"
                      value={experienceLevel}
                      onChange={(e) => setExperienceLevel(e.target.value)}
                      className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2.5 text-sm text-white focus:border-[#3B82F6] focus:outline-none"
                    >
                      <option value="beginner">Beginner</option>
                      <option value="intermediate">Intermediate</option>
                      <option value="advanced">Advanced</option>
                      <option value="staff">Staff / Principal</option>
                    </select>
                  </div>

                  <div>
                    <label htmlFor="auth-tz" className="block text-xs font-medium text-slate-300">
                      IANA Timezone
                    </label>
                    <input
                      id="auth-tz"
                      type="text"
                      value={timezone}
                      onChange={(e) => setTimezone(e.target.value)}
                      className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2.5 font-mono text-sm text-white focus:border-[#3B82F6] focus:outline-none"
                    />
                  </div>
                </div>

                <div>
                  <label htmlFor="auth-skills" className="block text-xs font-medium text-slate-300">
                    Skills (comma-separated)
                  </label>
                  <input
                    id="auth-skills"
                    type="text"
                    value={skillsText}
                    onChange={(e) => setSkillsText(e.target.value)}
                    className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2.5 text-sm text-white focus:border-[#3B82F6] focus:outline-none"
                  />
                </div>

                <div>
                  <label htmlFor="auth-bio" className="block text-xs font-medium text-slate-300">
                    Profile Summary
                  </label>
                  <textarea
                    id="auth-bio"
                    rows={2}
                    value={bio}
                    onChange={(e) => setBio(e.target.value)}
                    placeholder="Backend systems, SQL tuning, or frontend architecture..."
                    className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2 text-sm text-white focus:border-[#3B82F6] focus:outline-none"
                  />
                </div>
              </>
            )}

            <button
              type="submit"
              disabled={submitting}
              className="w-full rounded-lg bg-[#3B82F6] px-4 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-[#2563EB] disabled:opacity-50"
            >
              {submitting
                ? 'Authenticating...'
                : mode === 'login'
                  ? 'Sign In'
                  : 'Create Account'}
            </button>
          </form>

          <div className="mt-5 border-t border-white/[0.08] pt-5">
            <button
              type="button"
              onClick={handleGoogleLogin}
              disabled={submitting}
              className="w-full rounded-lg border border-white/10 bg-[#090B10] px-4 py-2.5 text-xs font-medium text-slate-200 transition-colors hover:border-white/25 hover:bg-white/5 disabled:opacity-50"
            >
              Continue with Google SSO
            </button>
          </div>
        </div>

        {/* Seeded Demo Accounts for Rapid Inspection */}
        <div className="rounded-xl border border-white/[0.08] bg-[#11151E] p-6 sm:p-8 lg:col-span-5">
          <h2 className="font-display text-base font-semibold text-white">
            Instant Demo Accounts
          </h2>
          <p className="mt-1.5 text-xs leading-relaxed text-slate-400">
            Select any seeded account below to authenticate immediately against the PostgreSQL backend
            and test team leadership, RBAC, or RaceLab experiments.
          </p>

          <div className="mt-5 space-y-3">
            {DEMO_ACCOUNTS.map((acct) => (
              <button
                key={acct.email}
                type="button"
                disabled={submitting}
                onClick={() => handleQuickDemo(acct.email)}
                className="w-full rounded-lg border border-white/[0.08] bg-[#090B10] p-4 text-left transition-colors hover:border-[#3B82F6]/60 hover:bg-[#161B26] disabled:opacity-50"
              >
                <p className="text-sm font-semibold text-white">{acct.label}</p>
                <p className="mt-1 font-mono text-xs text-[#3B82F6]">{acct.email}</p>
                <p className="mt-1 text-xs text-slate-400">{acct.role}</p>
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
