import test from 'node:test';
import assert from 'node:assert/strict';
import {
  canMarkTeamReady,
  canonicalizePayload,
  computeTimezoneDiffHours,
  rankTeammateCandidates,
  scoreTeammateCandidate,
} from './logic';

test('timezone offset calculation handles matching and distant IANA zones', () => {
  assert.equal(computeTimezoneDiffHours('America/New_York', 'America/New_York'), 0);
  const nyToLondon = computeTimezoneDiffHours('America/New_York', 'Europe/London');
  assert.equal(nyToLondon, 5);
});

test('recommendation engine weights 70% skill compatibility and 30% timezone compatibility', () => {
  const highMatch = scoreTeammateCandidate(
    {
      id: 'u1',
      fullName: 'Alice Chen',
      skills: ['PostgreSQL', 'Rust', 'React'],
      experienceLevel: 'advanced',
      timezone: 'America/Los_Angeles',
    },
    {
      requiredSkills: ['PostgreSQL', 'Rust', 'TypeScript'],
      existingMemberSkills: ['TypeScript'],
      leaderTimezone: 'America/Los_Angeles',
    }
  );

  const lowMatch = scoreTeammateCandidate(
    {
      id: 'u2',
      fullName: 'Bob Patel',
      skills: ['TypeScript'],
      experienceLevel: 'beginner',
      timezone: 'Asia/Kolkata',
    },
    {
      requiredSkills: ['PostgreSQL', 'Rust', 'TypeScript'],
      existingMemberSkills: ['TypeScript'],
      leaderTimezone: 'America/Los_Angeles',
    }
  );

  assert.equal(highMatch.timezoneScore, 100);
  assert.ok(highMatch.matchingScore > lowMatch.matchingScore);
  assert.deepEqual(highMatch.complementarySkills, ['PostgreSQL', 'Rust', 'React']);
  assert.equal(
    highMatch.matchingScore,
    Math.round(highMatch.skillScore * 0.7 + highMatch.timezoneScore * 0.3)
  );
});

test('rankTeammateCandidates sorts deterministically by score descending', () => {
  const ranked = rankTeammateCandidates(
    [
      {
        id: 'u2',
        fullName: 'Bob',
        skills: ['CSS'],
        experienceLevel: 'beginner',
        timezone: 'Asia/Tokyo',
      },
      {
        id: 'u1',
        fullName: 'Alice',
        skills: ['PostgreSQL', 'Go'],
        experienceLevel: 'staff',
        timezone: 'America/New_York',
      },
    ],
    {
      requiredSkills: ['PostgreSQL', 'Go'],
      existingMemberSkills: ['React'],
      leaderTimezone: 'America/New_York',
    }
  );

  assert.equal(ranked[0].userId, 'u1');
  assert.equal(ranked[1].userId, 'u2');
});

test('canMarkTeamReady enforces minimum team size rule', () => {
  assert.equal(canMarkTeamReady(1, 2).allowed, false);
  assert.equal(canMarkTeamReady(2, 2).allowed, true);
  assert.equal(canMarkTeamReady(4, 2).allowed, true);
});

test('canonicalizePayload produces identical output regardless of key order', () => {
  const a = canonicalizePayload({ b: 2, a: 1, nested: { y: true, x: 'ok' } });
  const b = canonicalizePayload({ nested: { x: 'ok', y: true }, a: 1, b: 2 });
  assert.equal(a, b);
});
