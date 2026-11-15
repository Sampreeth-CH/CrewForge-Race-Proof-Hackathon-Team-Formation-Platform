import React from 'react';
import { Navbar } from './Navbar';

export function Layout({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-screen flex-col bg-[#090B10] text-[#E6EDF3]">
      <Navbar />
      <main className="flex-1">{children}</main>
      <footer className="border-t border-white/[0.06] bg-[#090B10] py-8">
        <div className="mx-auto flex max-w-7xl flex-col items-start justify-between gap-4 px-4 text-xs text-slate-500 sm:flex-row sm:items-center sm:px-6 lg:px-8">
          <p>CrewForge · Transactional Hackathon Team Formation Platform</p>
          <p>PostgreSQL Row-Level Locking · Idempotent Mutations · SHA-256 Invites</p>
        </div>
      </footer>
    </div>
  );
}
