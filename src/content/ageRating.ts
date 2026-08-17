import type { ContentSignal, ProviderResult } from '../providers/types.js';

/**
 * Turns raw provider signals (subjects, BISAC categories, maturity flags) into
 * an age band plus content flags.
 *
 * This is a heuristic over how librarians and publishers *shelve* a book, not a
 * content review. It is good at "this is shelved as juvenile fiction" and bad at
 * "chapter 14 has a graphic scene". Treat low-confidence results as prompts to
 * check a title yourself, and see docs/content-ratings.md for the limits.
 */

export const AGE_BANDS = ['early-reader', 'middle-grade', 'young-adult', 'adult'] as const;
export type AgeBand = (typeof AGE_BANDS)[number];

export const CONTENT_FLAGS = [
  'violence',
  'sexual-content',
  'profanity',
  'substance-use',
  'horror',
  'romance',
  'self-harm',
  'religion',
] as const;
export type ContentFlag = (typeof CONTENT_FLAGS)[number];

/** Approximate reader age each band targets. Used for `--max-age` filtering. */
export const BAND_MIN_AGE: Record<AgeBand, number> = {
  'early-reader': 5,
  'middle-grade': 9,
  'young-adult': 13,
  adult: 18,
};

interface Rule {
  pattern: RegExp;
  band?: AgeBand;
  flags?: ContentFlag[];
  /** Multiplied by the signal's own weight. */
  strength: number;
}

const RULES: Rule[] = [
  // --- Audience shelving. The strongest and least ambiguous signals. ---
  { pattern: /\b(board books?|picture books?|beginner readers?|early readers?)\b/i, band: 'early-reader', strength: 1 },
  { pattern: /\bages?\s*(0|1|2|3|4|5|6|7)\s*[-–]\s*(6|7|8)\b/i, band: 'early-reader', strength: 1 },
  { pattern: /\breaders? (for|level) (beginner|1|2)\b/i, band: 'early-reader', strength: 0.8 },

  { pattern: /\b(middle grade|middle-grade)\b/i, band: 'middle-grade', strength: 1 },
  { pattern: /\b(juvenile fiction|juvenile nonfiction|juvenile literature|children'?s (fiction|stories|literature))\b/i, band: 'middle-grade', strength: 0.9 },
  { pattern: /\bages?\s*(8|9|10)\s*[-–]\s*(11|12|13)\b/i, band: 'middle-grade', strength: 1 },
  { pattern: /\bchapter books?\b/i, band: 'middle-grade', strength: 0.7 },

  { pattern: /\b(young adult|ya fiction|teen fiction|teenage fiction)\b/i, band: 'young-adult', strength: 1 },
  { pattern: /\bages?\s*(12|13|14)\s*(\+|up|and up|[-–]\s*(17|18))\b/i, band: 'young-adult', strength: 1 },
  // Deliberately no rule for "teenagers" / "high school students" on their own:
  // those describe a book's characters, not its audience. Blood Meridian is
  // shelved under "Teenage boys".

  { pattern: /\b(adult fiction|literary fiction|new adult)\b/i, band: 'adult', strength: 0.6 },
  { pattern: /^MATURE$/, band: 'adult', flags: ['sexual-content'], strength: 1 },

  // --- Content themes. These flag, and some also push the band upward. ---
  { pattern: /\b(erotic|erotica|sexual content|explicit sex|pornograph)/i, band: 'adult', flags: ['sexual-content'], strength: 1 },
  { pattern: /\b(sex|sexuality|sexual (abuse|assault|violence)|rape)\b/i, flags: ['sexual-content'], strength: 0.8 },
  { pattern: /\b(romance|love stories|romantic suspense)\b/i, flags: ['romance'], strength: 0.7 },

  { pattern: /\b(graphic violence|torture|gore|massacres?)\b/i, band: 'adult', flags: ['violence'], strength: 0.9 },
  { pattern: /\b(violence|murders?|war|combat|homicides?|serial killers?)\b/i, flags: ['violence'], strength: 0.7 },

  { pattern: /\b(profanity|obscenit|vulgarity)/i, flags: ['profanity'], strength: 0.8 },

  { pattern: /\b(drug (use|abuse|addiction)|alcoholism|substance abuse|narcotics)\b/i, flags: ['substance-use'], strength: 0.8 },
  { pattern: /\b(smoking|drinking|intoxication)\b/i, flags: ['substance-use'], strength: 0.4 },

  { pattern: /\b(horror|supernatural|ghosts?|demons?|zombies?|vampires?)\b/i, flags: ['horror'], strength: 0.6 },

  { pattern: /\b(suicide|self-harm|self injury|cutting)\b/i, flags: ['self-harm'], strength: 0.9 },

  { pattern: /\b(religion|religious|christian|christianity|islam|judaism|buddhis|spirituality|bible)\b/i, flags: ['religion'], strength: 0.6 },
];

export interface FlagAssessment {
  flag: ContentFlag;
  confidence: number;
  evidence: string[];
}

export interface ContentAssessment {
  band: AgeBand | 'unknown';
  /** 0..1. Below ~0.4 the answer is a guess — surface it for human review. */
  confidence: number;
  flags: FlagAssessment[];
  /** Per-band scores, for debugging why a band won. */
  scores: Record<AgeBand, number>;
  /** Provider signals that matched at least one rule. */
  evidence: string[];
  sources: string[];
  averageRating?: number;
  ratingsCount?: number;
}

/** ABS has no rating field, so assessments are written as namespaced tags. */
export const TAG_PREFIX = {
  age: 'age:',
  content: 'content:',
  marker: 'abs-butler:rated',
} as const;

export function assessContent(results: ProviderResult[]): ContentAssessment {
  const scores: Record<AgeBand, number> = {
    'early-reader': 0,
    'middle-grade': 0,
    'young-adult': 0,
    adult: 0,
  };
  const flagScores = new Map<ContentFlag, { score: number; evidence: Set<string> }>();
  const evidence = new Set<string>();

  for (const result of results) {
    // A rule scores at most once per provider, taking its strongest match.
    // Crowd-sourced subject lists repeat themselves — Open Library shelves The
    // Very Hungry Caterpillar under "Children's fiction", "Juvenile fiction",
    // "Juvenile", and "Children's stories, American" all at once. Summing those
    // would let one restated idea outvote a genuinely different signal.
    const best = new Map<Rule, { contribution: number; signal: ContentSignal }>();

    for (const signal of result.signals ?? []) {
      for (const rule of RULES) {
        if (!rule.pattern.test(signal.value)) continue;
        const contribution = rule.strength * signal.weight;
        const previous = best.get(rule);
        if (!previous || contribution > previous.contribution) {
          best.set(rule, { contribution, signal });
        }
      }
    }

    for (const [rule, { contribution, signal }] of best) {
      evidence.add(`${signal.source}: ${signal.value}`);
      if (rule.band) scores[rule.band] += contribution;
      for (const flag of rule.flags ?? []) {
        const entry = flagScores.get(flag) ?? { score: 0, evidence: new Set<string>() };
        entry.score += contribution;
        entry.evidence.add(signal.value);
        flagScores.set(flag, entry);
      }
    }
  }

  const ranked = (Object.entries(scores) as Array<[AgeBand, number]>).sort((a, b) => b[1] - a[1]);
  const [topBand, topScore] = ranked[0]!;
  const runnerUp = ranked[1]?.[1] ?? 0;

  // Confidence combines how strong the winning evidence is (volume) with how
  // clearly it beat the runner-up (margin). A book scoring 0.9 YA against 0.85
  // middle-grade is genuinely ambiguous and should say so.
  //
  // Volume is scaled against ONE full-strength rule, not a sum: since each rule
  // scores at most once per provider, a single authoritative shelving like
  // "Young adult fiction" is already all the evidence there is to have.
  const total = topScore + runnerUp;
  const margin = total > 0 ? (topScore - runnerUp) / total : 0;
  const volume = Math.min(1, topScore / 0.9);
  const confidence = topScore === 0 ? 0 : round(volume * (0.55 + 0.45 * margin));

  const flags: FlagAssessment[] = [...flagScores.entries()]
    .map(([flag, entry]) => ({
      flag,
      confidence: round(Math.min(1, entry.score / 1.5)),
      evidence: [...entry.evidence].slice(0, 5),
    }))
    .filter((f) => f.confidence >= 0.2)
    .sort((a, b) => b.confidence - a.confidence);

  const rated = results.filter((r) => typeof r.averageRating === 'number');

  return {
    band: topScore === 0 ? 'unknown' : topBand,
    confidence: Math.min(1, confidence),
    flags,
    scores,
    evidence: [...evidence].slice(0, 20),
    sources: results.map((r) => r.provider),
    averageRating: rated.length
      ? round(rated.reduce((sum, r) => sum + (r.averageRating ?? 0), 0) / rated.length)
      : undefined,
    ratingsCount: results.reduce((sum, r) => sum + (r.ratingsCount ?? 0), 0) || undefined,
  };
}

/** Renders an assessment as ABS tags. Only emits what clears `minConfidence`. */
export function assessmentToTags(
  assessment: ContentAssessment,
  options: { minConfidence?: number } = {},
): string[] {
  const min = options.minConfidence ?? 0.35;
  const tags: string[] = [TAG_PREFIX.marker];
  if (assessment.band !== 'unknown' && assessment.confidence >= min) {
    tags.push(`${TAG_PREFIX.age}${assessment.band}`);
  }
  for (const flag of assessment.flags) {
    if (flag.confidence >= min) tags.push(`${TAG_PREFIX.content}${flag.flag}`);
  }
  return tags;
}

/** True for tags this tool owns, so a re-run can replace them without touching yours. */
export function isButlerTag(tag: string): boolean {
  return (
    tag === TAG_PREFIX.marker ||
    tag.startsWith(TAG_PREFIX.age) ||
    tag.startsWith(TAG_PREFIX.content)
  );
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}
