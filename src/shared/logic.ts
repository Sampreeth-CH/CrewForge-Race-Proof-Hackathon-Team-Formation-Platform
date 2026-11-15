export interface RecommendationCandidateInput {
  id: string;
  fullName: string;
  skills: string[];
  experienceLevel: string;
  timezone: string;
}

export interface TeamRecommendationContext {
  requiredSkills: string[];
  existingMemberSkills: string[];
  leaderTimezone: string;
}

export interface TeammateRecommendation {
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

const EXPERIENCE_WEIGHT: Record<string, number> = {
  beginner: 0.75,
  intermediate: 0.9,
  advanced: 1.0,
  staff: 1.0,
};

export function normalizeSkill(skill: string): string {
  return skill.trim().toLowerCase();
}

/**
 * Computes UTC offset in hours for an IANA timezone string deterministically.
 */
export function getTimezoneOffsetHours(timeZone: string, referenceDate = new Date('2026-06-15T12:00:00Z')): number {
  try {
    const formatter = new Intl.DateTimeFormat('en-US', {
      timeZone,
      timeZoneName: 'shortOffset',
    });
    const parts = formatter.formatToParts(referenceDate);
    const tzName = parts.find((p) => p.type === 'timeZoneName')?.value ?? 'GMT';
    if (tzName === 'GMT' || tzName === 'UTC') return 0;
    const match = tzName.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
    if (!match) return 0;
    const sign = match[1] === '-' ? -1 : 1;
    const hours = Number(match[2]);
    const minutes = match[3] ? Number(match[3]) / 60 : 0;
    return sign * (hours + minutes);
  } catch {
    return 0;
  }
}

export function computeTimezoneDiffHours(tzA: string, tzB: string): number {
  const offsetA = getTimezoneOffsetHours(tzA);
  const offsetB = getTimezoneOffsetHours(tzB);
  const rawDiff = Math.abs(offsetA - offsetB);
  // Circular 24-hour distance
  const circular = Math.min(rawDiff, 24 - rawDiff);
  return Math.round(circular * 10) / 10;
}

/**
 * Deterministic Teammate Recommendation Engine
 * Formula: Final Score = 70% Skill Compatibility + 30% Timezone Compatibility
 */
export function scoreTeammateCandidate(
  candidate: RecommendationCandidateInput,
  team: TeamRecommendationContext
): TeammateRecommendation {
  const normalizedCandidateSkills = candidate.skills.map(normalizeSkill);
  const candidateSkillSet = new Set(normalizedCandidateSkills);

  const normalizedRequired = Array.from(new Set(team.requiredSkills.map(normalizeSkill))).filter(Boolean);
  const existingSkillSet = new Set(team.existingMemberSkills.map(normalizeSkill));

  const missingRequiredSkills = normalizedRequired.filter((s) => !existingSkillSet.has(s));
  const targetSkills = missingRequiredSkills.length > 0 ? missingRequiredSkills : normalizedRequired;

  const matchingSkills = candidate.skills.filter((s) =>
    normalizedRequired.includes(normalizeSkill(s))
  );

  // Complementary skills are skills the candidate brings that the current team lacks
  const complementarySkills = candidate.skills.filter(
    (s) => !existingSkillSet.has(normalizeSkill(s))
  );

  let skillScore = 0;
  if (targetSkills.length > 0) {
    const missingCovered = targetSkills.filter((s) => candidateSkillSet.has(s)).length;
    const missingCoverageRatio = missingCovered / targetSkills.length;
    const uniqueContributionBonus = Math.min(complementarySkills.length / 4, 1) * 0.2;
    const expMultiplier = EXPERIENCE_WEIGHT[candidate.experienceLevel] ?? 0.9;
    skillScore = Math.min(100, Math.round((missingCoverageRatio * 80 + uniqueContributionBonus * 100) * expMultiplier));
  } else {
    // When no explicit required skills are set, reward complementary skills the team lacks
    const uniqueContribution = Math.min(complementarySkills.length / 3, 1);
    skillScore = Math.round(uniqueContribution * 100);
  }

  const timezoneDiffHours = computeTimezoneDiffHours(candidate.timezone, team.leaderTimezone);
  // 0h diff -> 100, 12h diff -> 0
  const timezoneScore = Math.max(0, Math.round((1 - timezoneDiffHours / 12) * 100));

  const matchingScore = Math.round(skillScore * 0.7 + timezoneScore * 0.3);

  const reasons: string[] = [];
  if (complementarySkills.length > 0) {
    reasons.push(`Adds missing ${complementarySkills.slice(0, 3).join(', ')}`);
  } else if (matchingSkills.length > 0) {
    reasons.push(`Matches required ${matchingSkills.slice(0, 3).join(', ')}`);
  } else {
    reasons.push('General engineering background');
  }

  if (timezoneDiffHours <= 2) {
    reasons.push(`aligned timezone (${timezoneDiffHours}h offset)`);
  } else if (timezoneDiffHours <= 5) {
    reasons.push(`moderate timezone overlap (${timezoneDiffHours}h offset)`);
  } else {
    reasons.push(`${timezoneDiffHours}h timezone gap`);
  }

  return {
    userId: candidate.id,
    candidateName: candidate.fullName,
    experienceLevel: candidate.experienceLevel,
    timezone: candidate.timezone,
    matchingScore,
    skillScore,
    timezoneScore,
    matchingSkills,
    complementarySkills,
    timezoneDiffHours,
    explanation: `${reasons.join('; ')}. Weighted score: 70% skill (${skillScore}) + 30% timezone (${timezoneScore}).`,
  };
}

export function rankTeammateCandidates(
  candidates: RecommendationCandidateInput[],
  team: TeamRecommendationContext,
  limit = 10
): TeammateRecommendation[] {
  return candidates
    .map((candidate) => scoreTeammateCandidate(candidate, team))
    .sort((a, b) => {
      if (b.matchingScore !== a.matchingScore) return b.matchingScore - a.matchingScore;
      if (b.complementarySkills.length !== a.complementarySkills.length) {
        return b.complementarySkills.length - a.complementarySkills.length;
      }
      return a.candidateName.localeCompare(b.candidateName);
    })
    .slice(0, limit);
}

/**
 * Validates whether a team can transition to 'ready' status.
 */
export function canMarkTeamReady(memberCount: number, minTeamSize: number): { allowed: boolean; reason?: string } {
  if (memberCount < minTeamSize) {
    return {
      allowed: false,
      reason: `Team needs at least ${minTeamSize} members before marking ready (currently ${memberCount}).`,
    };
  }
  return { allowed: true };
}

/**
 * Validates canonical JSON equality for idempotency checks.
 */
export function canonicalizePayload(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalizePayload).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalizePayload(v)}`).join(',')}}`;
}
