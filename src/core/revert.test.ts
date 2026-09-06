import { describe, expect, it } from 'vitest';
import type { AbsLibraryItem, AbsMediaPatch } from '../abs/types.js';
import { inversePatch } from './revisions.js';
import { changedSince, patchFields } from './revert.js';

function book(metadata: Record<string, unknown>, tags: string[] = []): AbsLibraryItem {
  return {
    id: 'item-1',
    media: { id: 'm', coverPath: null, tags, metadata },
  } as unknown as AbsLibraryItem;
}

describe('inversePatch', () => {
  it('captures only the fields the outgoing patch touches', () => {
    const item = book({ title: 'Hobbit, The', subtitle: 'A Tale', publisher: 'Allen & Unwin' });
    const inverse = inversePatch(item, { metadata: { title: 'The Hobbit' } });
    expect(inverse).toEqual({ metadata: { title: 'Hobbit, The' } });
  });

  // The honest inverse of supplying a value is removing it again.
  it('records a missing value as null so restoring clears it', () => {
    const inverse = inversePatch(book({ title: 'Dune' }), { metadata: { subtitle: 'Book One' } });
    expect(inverse).toEqual({ metadata: { subtitle: null } });
  });

  it('captures authors as the patch shape ABS accepts', () => {
    const item = book({ authors: [{ id: 'a1', name: 'Terry Pratchett' }, { id: 'a2', name: 'Neil Gaiman' }] });
    const inverse = inversePatch(item, { metadata: { authors: [{ name: 'Terry Pratchett' }] } });
    expect(inverse.metadata?.authors).toEqual([{ name: 'Terry Pratchett' }, { name: 'Neil Gaiman' }]);
  });

  it('captures a series with its sequence', () => {
    const item = book({ series: [{ id: 's', name: 'Barsoom', sequence: '3' }] });
    const inverse = inversePatch(item, { metadata: { series: [{ name: 'The Barsoom Series' }] } });
    expect(inverse.metadata?.series).toEqual([{ name: 'Barsoom', sequence: '3' }]);
  });

  it('captures the whole tag list, including tags it does not own', () => {
    const item = book({}, ['fiction', 'abs-butler:rated', 'age:adult']);
    const inverse = inversePatch(item, { tags: ['fiction', 'age:young-adult'] });
    expect(inverse.tags).toEqual(['fiction', 'abs-butler:rated', 'age:adult']);
  });

  it('is a genuine round trip', () => {
    const item = book({ title: 'Hobbit, The', authors: [{ id: 'a', name: 'Tolkien, J.R.R.' }] });
    const forward: AbsMediaPatch = {
      metadata: { title: 'The Hobbit', authors: [{ name: 'J.R.R. Tolkien' }] },
    };
    const back = inversePatch(item, forward);
    expect(back.metadata?.title).toBe('Hobbit, The');
    expect(back.metadata?.authors).toEqual([{ name: 'Tolkien, J.R.R.' }]);
  });
});

describe('changedSince', () => {
  const after: AbsMediaPatch = { metadata: { title: 'The Hobbit' } };

  it('is silent when the item still looks the way the run left it', () => {
    expect(changedSince(book({ title: 'The Hobbit' }), after)).toBeNull();
  });

  // Restoring over a hand correction would throw away newer work silently,
  // which is worse than the value it was fixing.
  it('notices an edit made since the run', () => {
    expect(changedSince(book({ title: 'The Hobbit: A Tale' }), after)).toMatch(/title/);
  });

  it('compares authors by name rather than by object identity', () => {
    const written: AbsMediaPatch = { metadata: { authors: [{ name: 'J.R.R. Tolkien' }] } };
    const item = book({ authors: [{ id: 'generated-by-abs', name: 'J.R.R. Tolkien' }] });
    expect(changedSince(item, written)).toBeNull();
  });

  it('compares series by name and sequence together', () => {
    const written: AbsMediaPatch = { metadata: { series: [{ name: 'Barsoom', sequence: '3' }] } };
    expect(changedSince(book({ series: [{ id: 's', name: 'Barsoom', sequence: '3' }] }), written)).toBeNull();
    expect(changedSince(book({ series: [{ id: 's', name: 'Barsoom', sequence: '4' }] }), written)).toMatch(/series/);
  });

  it('ignores tag order', () => {
    const written: AbsMediaPatch = { tags: ['a', 'b'] };
    expect(changedSince(book({}, ['b', 'a']), written)).toBeNull();
    expect(changedSince(book({}, ['a']), written)).toMatch(/tags/);
  });
});

describe('patchFields', () => {
  it('names what a patch would restore', () => {
    expect(patchFields({ metadata: { title: 'x', authors: [] }, tags: [] })).toEqual([
      'title',
      'authors',
      'tags',
    ]);
  });
});
