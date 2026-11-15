import { useState } from 'react';
import { Link, NavLink } from 'react-router-dom';
import { Menu, X } from 'lucide-react';
import { useAuth } from '../context/AuthContext';

export function Navbar() {
  const { user } = useAuth();
  const [mobileOpen, setMobileOpen] = useState(false);

  const navLinks = [
    { to: '/dashboard', label: 'Dashboard' },
    { to: '/teams', label: 'Teams' },
    { to: '/racelab', label: 'RaceLab' },
    { to: '/audit', label: 'Audit Explorer' },
  ];

  return (
    <header className="sticky top-0 z-40 border-b border-white/[0.08] bg-[#090B10]/95 backdrop-blur-sm">
      <div className="mx-auto flex h-16 max-w-7xl items-center justify-between gap-8 px-4 sm:px-6 lg:px-8">
        {/* Zone 1: Single-line brand wordmark */}
        <Link
          to="/"
          className="font-display text-lg font-bold tracking-tight text-white whitespace-nowrap shrink-0"
        >
          CrewForge
        </Link>

        {/* Zone 2: 4 concise single-line nav links */}
        <nav aria-label="Primary navigation" className="hidden md:flex items-center gap-7">
          {navLinks.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) =>
                `text-sm font-medium transition-colors whitespace-nowrap shrink-0 ${
                  isActive
                    ? 'text-white underline decoration-[#3B82F6] decoration-2 underline-offset-8'
                    : 'text-slate-400 hover:text-slate-100'
                }`
              }
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        {/* Zone 3: 1 primary action */}
        <div className="hidden md:flex items-center shrink-0">
          {user ? (
            <Link
              to="/profile"
              className="rounded-lg border border-white/10 bg-[#131722] px-4 py-2 text-xs font-medium text-slate-100 transition-colors hover:border-[#3B82F6]/60 hover:bg-[#1A202E] whitespace-nowrap shrink-0 max-w-[180px] truncate"
            >
              {user.fullName}
            </Link>
          ) : (
            <Link
              to="/login"
              className="rounded-lg bg-[#3B82F6] px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-[#2563EB] whitespace-nowrap shrink-0"
            >
              Sign In
            </Link>
          )}
        </div>

        <button
          type="button"
          onClick={() => setMobileOpen((prev) => !prev)}
          aria-label={mobileOpen ? 'Close navigation menu' : 'Open navigation menu'}
          aria-expanded={mobileOpen}
          className="inline-flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 text-slate-300 hover:bg-white/5 md:hidden"
        >
          {mobileOpen ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      {mobileOpen && (
        <div className="border-t border-white/[0.08] bg-[#0D1017] px-4 py-4 md:hidden">
          <nav aria-label="Mobile navigation" className="flex flex-col gap-2">
            {navLinks.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                onClick={() => setMobileOpen(false)}
                className={({ isActive }) =>
                  `rounded-lg px-3 py-2.5 text-sm font-medium ${
                    isActive ? 'bg-[#3B82F6]/15 text-white' : 'text-slate-300 hover:bg-white/5'
                  }`
                }
              >
                {item.label}
              </NavLink>
            ))}
            <div className="mt-2 border-t border-white/[0.08] pt-3">
              {user ? (
                <Link
                  to="/profile"
                  onClick={() => setMobileOpen(false)}
                  className="block rounded-lg border border-white/10 bg-[#131722] px-3 py-2.5 text-center text-sm font-medium text-white"
                >
                  {user.fullName} · Profile
                </Link>
              ) : (
                <Link
                  to="/login"
                  onClick={() => setMobileOpen(false)}
                  className="block rounded-lg bg-[#3B82F6] px-3 py-2.5 text-center text-sm font-semibold text-white"
                >
                  Sign In
                </Link>
              )}
            </div>
          </nav>
        </div>
      )}
    </header>
  );
}
