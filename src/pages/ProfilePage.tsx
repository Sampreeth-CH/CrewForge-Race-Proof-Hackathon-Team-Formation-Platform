import React, { useEffect, useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { LogOut, Save } from 'lucide-react';
import { api, extractApiError } from '../lib/api';
import { useAuth } from '../context/AuthContext';
import { useToast } from '../context/ToastContext';

export function ProfilePage() {
  const { user, loading, logout, refreshMe } = useAuth();
  const { pushToast } = useToast();
  const navigate = useNavigate();

  const [fullName, setFullName] = useState('');
  const [bio, setBio] = useState('');
  const [skillsText, setSkillsText] = useState('');
  const [experienceLevel, setExperienceLevel] = useState('intermediate');
  const [timezone, setTimezone] = useState('UTC');
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (user) {
      setFullName(user.fullName);
      setBio(user.bio);
      setSkillsText(user.skills.join(', '));
      setExperienceLevel(user.experienceLevel);
      setTimezone(user.timezone);
    }
  }, [user]);

  if (loading) {
    return (
      <div className="mx-auto max-w-3xl px-4 py-12">
        <div className="h-64 animate-pulse rounded-xl bg-[#11151E]" />
      </div>
    );
  }

  if (!user) {
    return (
      <div className="mx-auto max-w-xl px-4 py-16 text-center">
        <h1 className="font-display text-2xl font-bold text-white">Profile</h1>
        <p className="mt-2 text-sm text-slate-400">Sign in to manage your engineering profile.</p>
        <Link
          to="/login"
          className="mt-5 inline-block rounded-lg bg-[#3B82F6] px-5 py-2.5 text-xs font-semibold text-white"
        >
          Sign In
        </Link>
      </div>
    );
  }

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    try {
      const skills = skillsText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      await api.patch('/auth/profile', {
        fullName,
        bio,
        skills,
        experienceLevel,
        timezone,
      });
      await refreshMe();
      pushToast({ variant: 'success', title: 'Profile updated' });
    } catch (err) {
      pushToast({ variant: 'error', title: 'Update failed', description: extractApiError(err) });
    } finally {
      setSaving(false);
    }
  };

  const handleLogout = async () => {
    await logout();
    pushToast({ variant: 'info', title: 'Signed out' });
    navigate('/');
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-8 sm:px-6 lg:px-8">
      <div className="flex items-center justify-between border-b border-white/[0.08] pb-6">
        <div>
          <h1 className="font-display text-2xl font-bold text-white">Engineering Profile</h1>
          <p className="mt-1 text-xs text-slate-400">
            {user.email} · Role: {user.role} · Joined {new Date(user.createdAt).toLocaleDateString()}
          </p>
        </div>
        <button
          type="button"
          onClick={handleLogout}
          className="inline-flex items-center gap-1.5 rounded-lg border border-white/10 px-3.5 py-2 text-xs font-medium text-slate-200 hover:bg-white/5"
        >
          <LogOut className="h-3.5 w-3.5" />
          Sign Out
        </button>
      </div>

      <form
        onSubmit={handleSave}
        className="mt-6 space-y-5 rounded-xl border border-white/[0.08] bg-[#11151E] p-6"
      >
        <div>
          <label htmlFor="prof-name" className="block text-xs font-medium text-slate-300">
            Full Name
          </label>
          <input
            id="prof-name"
            type="text"
            required
            value={fullName}
            onChange={(e) => setFullName(e.target.value)}
            className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2.5 text-sm text-white focus:border-[#3B82F6] focus:outline-none"
          />
        </div>

        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
          <div>
            <label htmlFor="prof-exp" className="block text-xs font-medium text-slate-300">
              Experience Level
            </label>
            <select
              id="prof-exp"
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
            <label htmlFor="prof-tz" className="block text-xs font-medium text-slate-300">
              IANA Timezone
            </label>
            <input
              id="prof-tz"
              type="text"
              value={timezone}
              onChange={(e) => setTimezone(e.target.value)}
              className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2.5 font-mono text-sm text-white focus:border-[#3B82F6] focus:outline-none"
            />
          </div>
        </div>

        <div>
          <label htmlFor="prof-skills" className="block text-xs font-medium text-slate-300">
            Skills (comma-separated)
          </label>
          <input
            id="prof-skills"
            type="text"
            value={skillsText}
            onChange={(e) => setSkillsText(e.target.value)}
            className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2.5 text-sm text-white focus:border-[#3B82F6] focus:outline-none"
          />
        </div>

        <div>
          <label htmlFor="prof-bio" className="block text-xs font-medium text-slate-300">
            Bio
          </label>
          <textarea
            id="prof-bio"
            rows={3}
            value={bio}
            onChange={(e) => setBio(e.target.value)}
            className="mt-1.5 w-full rounded-lg border border-white/10 bg-[#090B10] px-3 py-2 text-sm text-white focus:border-[#3B82F6] focus:outline-none"
          />
        </div>

        <div className="flex justify-end">
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-1.5 rounded-lg bg-[#3B82F6] px-5 py-2.5 text-xs font-semibold text-white hover:bg-[#2563EB] disabled:opacity-50"
          >
            <Save className="h-3.5 w-3.5" />
            {saving ? 'Saving...' : 'Save Changes'}
          </button>
        </div>
      </form>
    </div>
  );
}
