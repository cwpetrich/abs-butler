import { describe, expect, it } from 'vitest';
import { assessContent, assessmentToTags, isButlerTag } from './ageRating.js';
import type { ProviderResult } from '../providers/types.js';

function result(subjects: string[], overrides: Partial<ProviderResult> = {}): ProviderResult {
  return {
    provider: 'test',
    subjects,
    signals: subjects.map((value) => ({ source: 'test:subject', value, weight: 1 })),
    ...overrides,
  };
}

describe('assessContent', () => {
  it('bands a picture book as early-reader', () => {
    const assessment = assessContent([result(['Picture books for children', 'Bedtime'])]);
    expect(assessment.band).toBe('early-reader');
    expect(assessment.confidence).toBeGreaterThan(0.4);
  });

  /**
   * The real ladder Audible files it under. The audience node sits at the top
   * ("Children's Audiobooks"), the claim at the bottom ("Early Readers"), and
   * a middle node contradicts both — a chapter book is middle grade. Weighted
   * as the provider weights them, the leaf has to win.
   */
  it('lets an Audible ladder leaf outvote the shelf above it', () => {
    const ladder = [
      { name: "Children's Audiobooks", weight: 0.55 },
      { name: 'Literature & Fiction', weight: 0.55 },
      { name: 'Chapter Books & Readers', weight: 0.55 },
      { name: 'Early Readers', weight: 0.9 },
    ];
    const assessment = assessContent([
      result([], {
        provider: 'audible',
        signals: ladder.map((c) => ({ source: 'audible:category', value: c.name, weight: c.weight })),
      }),
    ]);
    expect(assessment.band).toBe('early-reader');
    expect(assessment.confidence).toBeGreaterThan(0.4);
  });

  it("reads Audible's kids shelf alone as middle-grade, weakly", () => {
    const assessment = assessContent([
      result([], {
        provider: 'audible',
        signals: [{ source: 'audible:category', value: "Children's Audiobooks", weight: 0.55 }],
      }),
    ]);
    expect(assessment.band).toBe('middle-grade');
    // One broad node is a hint, not a verdict, and should say so.
    expect(assessment.confidence).toBeLessThan(0.4);
  });

  /**
   * Three sources each contributing a broad "kids book" term must not outvote
   * one naming a band outright. This is how *The Very Hungry Caterpillar* was
   * banded middle grade the day a third kids-shelf source was added.
   *
   * Note what is *not* claimed: a source shelving it as juvenile fiction is a
   * genuinely different assertion, scored far higher, and it is allowed to win.
   * Only the vague term is held down.
   */
  it('lets one precise band claim outvote several vague ones', () => {
    const kids = (provider: string, weight: number, value: string) =>
      result([], { provider, signals: [{ source: `${provider}:genre`, value, weight }] });

    const assessment = assessContent([
      result([], {
        provider: 'audible',
        signals: [
          { source: 'audible:category', value: "Children's Audiobooks", weight: 0.55 },
          { source: 'audible:category', value: 'Early Readers', weight: 0.9 },
        ],
      }),
      kids('audiosilo', 0.8, 'Childrens'),
      kids('audnexus', 0.9, 'Kids'),
    ]);
    expect(assessment.band).toBe('early-reader');
  });

  it("reads Audible's teen shelf as young-adult", () => {
    const assessment = assessContent([
      result([], {
        provider: 'audible',
        signals: [{ source: 'audible:category', value: 'Teen & Young Adult', weight: 0.55 }],
      }),
    ]);
    expect(assessment.band).toBe('young-adult');
  });

  it('bands juvenile fiction as middle-grade', () => {
    const assessment = assessContent([result(['Juvenile fiction', 'Adventure and adventurers'])]);
    expect(assessment.band).toBe('middle-grade');
  });

  it('bands young adult shelving as young-adult and keeps content flags', () => {
    const assessment = assessContent([result(['Young adult fiction', 'Violence', 'Drug abuse'])]);
    expect(assessment.band).toBe('young-adult');
    const flags = assessment.flags.map((f) => f.flag);
    expect(flags).toContain('violence');
    expect(flags).toContain('substance-use');
  });

  it('treats an explicit maturity rating as adult', () => {
    const assessment = assessContent([
      result([], { signals: [{ source: 'googlebooks:maturity', value: 'MATURE', weight: 0.9 }] }),
    ]);
    expect(assessment.band).toBe('adult');
  });

  it('returns unknown with zero confidence when nothing matches', () => {
    const assessment = assessContent([result(['Cartography', 'Nineteenth century'])]);
    expect(assessment.band).toBe('unknown');
    expect(assessment.confidence).toBe(0);
  });

  it('lowers confidence when two bands are close', () => {
    const clear = assessContent([result(['Young adult fiction', 'Teen fiction'])]);
    const muddled = assessContent([result(['Young adult fiction', 'Juvenile fiction'])]);
    expect(muddled.confidence).toBeLessThan(clear.confidence);
  });

  // Regression: Open Library restates one idea many ways. Summing every match
  // let "Children's fiction"/"Juvenile fiction"/"Juvenile"/"Children's stories"
  // outvote the single, more precise "Board books".
  it('does not let repeated near-duplicate subjects outvote a precise one', () => {
    const assessment = assessContent([
      result([
        'Board books',
        "Children's fiction",
        'Juvenile fiction',
        'Juvenile',
        "Children's stories, American",
        "Children's stories, English",
      ]),
    ]);
    expect(assessment.band).toBe('early-reader');
  });

  it('scores a rule once per provider but still adds across providers', () => {
    const single = assessContent([result(['Young adult fiction', 'Teen fiction'])]);
    const double = assessContent([result(['Young adult fiction']), { ...result(['Young adult fiction']), provider: 'other' }]);
    expect(double.scores['young-adult']).toBeGreaterThan(single.scores['young-adult']);
  });

  // Regression: \bmassacre\b never matched the actual subject "Massacres".
  it('matches pluralized violence subjects', () => {
    const assessment = assessContent([result(['Massacres', 'Outlaws'])]);
    expect(assessment.band).toBe('adult');
    expect(assessment.flags.map((f) => f.flag)).toContain('violence');
  });

  // "Teenage boys" is a subject on Blood Meridian; it describes characters, not audience.
  it('does not band a book as young-adult just for having teenage characters', () => {
    const assessment = assessContent([result(['Teenage boys', 'High school students'])]);
    expect(assessment.band).not.toBe('young-adult');
  });

  it('merges signals from multiple providers', () => {
    const assessment = assessContent([
      result(['Juvenile fiction']),
      { provider: 'other', signals: [{ source: 'other:cat', value: 'Middle grade', weight: 1 }] },
    ]);
    expect(assessment.band).toBe('middle-grade');
    expect(assessment.sources).toEqual(['test', 'other']);
  });
});

describe('assessmentToTags', () => {
  it('always emits the marker tag, even for an unknown band', () => {
    const tags = assessmentToTags(assessContent([result([])]));
    expect(tags).toEqual(['abs-butler:rated']);
  });

  it('omits the age tag below the confidence threshold', () => {
    const assessment = assessContent([result(['Young adult fiction'])]);
    const strict = assessmentToTags(assessment, { minConfidence: 0.99 });
    expect(strict.some((t) => t.startsWith('age:'))).toBe(false);
  });

  it('emits age and content tags when confident', () => {
    const tags = assessmentToTags(assessContent([result(['Young adult fiction', 'Violence', 'Murder'])]));
    expect(tags).toContain('age:young-adult');
    expect(tags).toContain('content:violence');
  });
});

describe('isButlerTag', () => {
  it('claims only its own namespaces', () => {
    expect(isButlerTag('age:adult')).toBe(true);
    expect(isButlerTag('content:violence')).toBe(true);
    expect(isButlerTag('abs-butler:rated')).toBe(true);
    expect(isButlerTag('favorites')).toBe(false);
    expect(isButlerTag('kids')).toBe(false);
  });
});

describe('one provider, one vote', () => {
  /**
   * The comment on assessContent always claimed a rule scores at most once per
   * provider. The loop was per *result*, which is a different thing the moment
   * a source answers with several editions — and they all do. Apple returns
   * eight usable hits for The Very Hungry Caterpillar, mostly spin-offs, each
   * carrying "Fiction for Kids"; counted eight times it buried the "Basic
   * Concepts for Kids" that made the book a picture book.
   */
  it('does not let a chatty provider outvote a specific signal', () => {
    const vague = (value: string) => ({ source: 'test:genre', value, weight: 0.8 });

    // One source, eight editions, all shelved as children's fiction; one of
    // them also says the thing that actually pins the age.
    const chatty = Array.from({ length: 8 }, (_, i) => ({
      provider: 'chatty',
      title: `Edition ${i}`,
      signals: [vague('Fiction for Kids')],
      ...(i === 0 ? { signals: [vague('Fiction for Kids'), vague('Basic Concepts for Kids')] } : {}),
    })) as unknown as Parameters<typeof assessContent>[0];

    expect(assessContent(chatty).band).toBe('early-reader');
  });

  it('still lets two independent providers each have their say', () => {
    const results = [
      { provider: 'a', signals: [{ source: 'a:genre', value: 'Young Adult', weight: 1 }] },
      { provider: 'b', signals: [{ source: 'b:genre', value: 'Young Adult', weight: 1 }] },
    ] as unknown as Parameters<typeof assessContent>[0];

    // Two sources agreeing is two contributions — the deduplication is within a
    // provider, not across them.
    const one = assessContent([results[0]!]);
    expect(assessContent(results).evidence.length).toBeGreaterThan(one.evidence.length);
  });
});
