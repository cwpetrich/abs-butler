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
