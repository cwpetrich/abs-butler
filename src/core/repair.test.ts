import { existsSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AbsAudioFile, AbsChapter, AbsLibrary, AbsLibraryItem, AbsMediaPatch } from '../abs/types.js';
import type { TaskContext } from '../context.js';
import { openMemoryDb, type Db } from '../db/index.js';
import { listRevisions } from '../db/revisions.js';
import { countRunItemPlans, listRunItems } from '../db/runItems.js';
import { createRun } from '../db/runs.js';
import { DEFAULT_SETTINGS, updateSettings } from '../db/settings.js';
import { runApplyTask } from './apply.js';
import { changedSince } from './revert.js';
import {
  assessItem,
  chooseMethod,
  runRepairTask,
  SYNTHETIC_INODE,
  TRACK_REPAIR_DISABLED,
  trimChapters,
  verifyRepair,
} from './repair.js';

/**
 * The repair has one job — each book plays at its real length again — and a
 * way to do it that is easy to get subtly wrong, because AudiobookShelf's own
 * "exclude" looks like the answer and is not. The fake server below behaves the
 * way 2.36 was measured to: the length is a stored number, and a rescan
 * recomputes it only when the records and the files on disk disagree in number
 * or a file changed, adding up every record including excluded ones.
 */

const library: AbsLibrary = { id: 'lib', name: 'Books', folders: [], mediaType: 'book', provider: 'audible' };

let db: Db;
let items: Map<string, AbsLibraryItem>;
let calls: string[];
/** Files a touch changed since the last rescan, by inode. */
let touched: Set<string>;

beforeEach(() => {
  db = openMemoryDb();
  items = new Map();
  calls = [];
  touched = new Set();
});

afterEach(() => {
  db.close();
});

function record(ino: string, filename: string, duration: number, extra: Partial<AbsAudioFile> = {}): AbsAudioFile {
  return {
    index: 0,
    ino,
    duration,
    metadata: { filename, path: `/books/x/${filename}`, relPath: filename, size: duration * 1000 },
    ...extra,
  };
}

/**
 * A book as the migration left it: every file on disk under a new inode, and
 * the old record for each still beside the new one, interleaved the way a
 * rescan's track ordering puts them.
 */
function migrated(id: string, parts: Array<[string, number]>, options: { chapters?: AbsChapter[] } = {}): AbsLibraryItem {
  const live = parts.map(([name, length], i) => record(String(100 + i), name, length));
  const dead = parts.map(([name, length], i) => record(String(900 + i), name, length));
  const audioFiles = live.flatMap((file, i) => [dead[i]!, file]);
  const item = {
    id,
    libraryId: 'lib',
    relPath: `Author/${id}`,
    path: `/books/Author/${id}`,
    isFile: false,
    media: {
      id: `m-${id}`,
      coverPath: null,
      tags: [],
      metadata: { title: id },
      audioFiles,
      chapters: options.chapters ?? [],
      duration: audioFiles.reduce((sum, file) => sum + file.duration, 0),
    },
    libraryFiles: live.map((file) => ({ ino: file.ino, fileType: 'audio', metadata: { ...file.metadata } })),
  } as unknown as AbsLibraryItem;
  items.set(id, item);
  return item;
}

function healthy(id: string): AbsLibraryItem {
  const item = migrated(id, [['01.mp3', 60]]);
  item.media.audioFiles = item.media.audioFiles!.filter((file) => Number(file.ino) < 900);
  item.media.duration = 60;
  return item;
}

function copy<T>(value: T): T {
  return structuredClone(value);
}

function fakeClient() {
  return {
    async listLibraries() {
      return [library];
    },
    async *iterateLibraryItems() {
      for (const item of items.values()) yield copy(item);
    },
    async getItem(id: string) {
      const item = items.get(id);
      if (!item) throw new Error('404');
      return copy(item);
    },
    async updateTracks(id: string, ordered: Array<{ ino: string; exclude?: boolean }>) {
      calls.push(`tracks ${id} ${ordered.map((o) => o.ino + (o.exclude ? 'x' : '')).join(',')}`);
      const media = items.get(id)!.media;
      // Whatever is sent becomes the list; anything left out is gone.
      media.audioFiles = ordered.map((entry) => ({
        ...media.audioFiles!.find((file) => file.ino === entry.ino)!,
        exclude: Boolean(entry.exclude),
      }));
    },
    async patchItemMedia(id: string, patch: AbsMediaPatch) {
      calls.push(`media ${id} ${Object.keys(patch).join(',')}`);
      const media = items.get(id)!.media;
      if (patch.audioFiles) media.audioFiles = copy(patch.audioFiles);
      if (patch.chapters) media.chapters = copy(patch.chapters);
    },
    async scanItem(id: string) {
      calls.push(`scan ${id}`);
      // As ABS does: a bare file is rescanned only by a library scan.
      if (items.get(id)!.isFile) throw new Error('500 Internal Server Error');
      return rescan(id);
    },
    async isScanningLibrary() {
      return false;
    },
    async scanLibrary(libraryId: string) {
      calls.push(`library-scan ${libraryId}`);
      // A library scan passes over any item whose files have not changed.
      for (const [id, item] of items) {
        if (item.libraryId === libraryId && item.libraryFiles!.some((file) => touched.has(file.ino))) {
          rescan(id, false);
        }
      }
      touched.clear();
    },
    async updateChapters(id: string, chapters: AbsChapter[]) {
      calls.push(`chapters ${id} ${chapters.length}`);
      items.get(id)!.media.chapters = copy(chapters);
    },
    async listUsers() {
      return [{ id: 'u1', username: 'reader' }];
    },
    async getUserProgress() {
      return [{ libraryItemId: 'double', duration: 1200, currentTime: 700, isFinished: false }];
    },
  };

  /** ABS's rescan of one item: records for files it lacks, and a length from every record. */
  function rescan(id: string, clearTouched = true) {
    const item = items.get(id)!;
    const media = item.media;
    const files = item.libraryFiles!;
    const changed = files.some((file) => touched.has(file.ino));
    if (!changed && files.length === media.audioFiles!.length) return 'UPTODATE';
    for (const file of files) {
      if (!media.audioFiles!.some((a) => a.ino === file.ino)) {
        media.audioFiles!.push(record(file.ino, file.metadata.filename, file.metadata.size / 1000));
      }
    }
    media.duration = media.audioFiles!.reduce((sum, file) => sum + file.duration, 0);
    if (clearTouched) touched.clear();
    return 'UPDATED';
  }
}

function context(options: { dryRun?: boolean; command?: 'repair' } = {}): TaskContext {
  return {
    db,
    connection: { url: 'http://localhost:13378', libraryRoot: null, pathPrefix: null } as TaskContext['connection'],
    client: fakeClient() as unknown as TaskContext['client'],
    settings: { ...DEFAULT_SETTINGS, allowTrackRepair: true },
    runId: createRun(db, {
      command: options.command ?? 'repair',
      options: {},
      dryRun: options.dryRun ?? true,
      trigger: 'manual',
    }).id,
  };
}

describe('assessItem', () => {
  it('finds the records whose files are gone, and the length without them', () => {
    const a = assessItem(migrated('double', [['01.mp3', 300], ['02.mp3', 300]]));
    expect(a.dead.map((f) => f.ino)).toEqual(['900', '901']);
    expect(a.live.map((f) => f.ino)).toEqual(['100', '101']);
    expect(a.durationBefore).toBe(1200);
    expect(a.durationAfter).toBe(600);
    expect(a.problem).toBeNull();
  });

  // Two real copies of a book are both on disk, so neither is dead: the test
  // that separates this from a duplicate is membership, not resemblance.
  it('does not mistake two real copies of a book for damage', () => {
    const item = healthy('both');
    item.media.audioFiles!.push(record('555', 'book.m4b', 60));
    item.libraryFiles!.push({ ino: '555', metadata: { filename: 'book.m4b', path: '/b', relPath: 'b', size: 1 } });
    expect(assessItem(item).dead).toEqual([]);
  });

  it('leaves alone a dead record with no live counterpart, which may be a real loss', () => {
    const item = migrated('lost', [['01.mp3', 300]]);
    item.media.audioFiles![0]!.metadata.filename = 'epilogue.mp3';
    expect(assessItem(item).problem).toContain('epilogue.mp3');
  });

  it('matches a counterpart on length when the size differs', () => {
    const item = migrated('resized', [['01.mp3', 300]]);
    item.media.audioFiles![0]!.metadata.size = 1;
    expect(assessItem(item).problem).toBeNull();
  });

  // Whether one can be mended is a question about this install, not the book —
  // see lengthPendingReason.
  it('does not count a bare file as uncertain', () => {
    const item = migrated('bare', [['book.m4b', 300]]);
    item.isFile = true;
    expect(assessItem(item).problem).toBeNull();
  });

  it('notices a length its tracks do not add up to once the dead records are gone', () => {
    const item = migrated('by-hand', [['01.mp3', 300]]);
    item.media.audioFiles = item.media.audioFiles!.filter((f) => f.ino === '100');
    expect(assessItem(item)).toMatchObject({ dead: [], staleLength: true, durationAfter: 300, problem: null });
    expect(assessItem(healthy('fine')).staleLength).toBe(false);
  });

  it('leaves alone an item that would have nothing playable left', () => {
    const item = migrated('excluded', [['01.mp3', 300]]);
    item.media.audioFiles![1]!.exclude = true;
    expect(assessItem(item).problem).toContain('No playable track');
  });

  it('notices inodes an SMB mount made up', () => {
    const item = migrated('smb', [['01.mp3', 300]]);
    const big = String(SYNTHETIC_INODE + 7);
    item.media.audioFiles![1]!.ino = big;
    item.libraryFiles![0]!.ino = big;
    expect(assessItem(item).synthetic).toBe(true);
  });
});

describe('chooseMethod', () => {
  it('uses the API-only route when there are two tracks to work with', () => {
    expect(chooseMethod(assessItem(migrated('a', [['01.mp3', 1], ['02.mp3', 1]])), true)).toBe('rescan-one');
  });

  it('drops only the records of a bare file it may not touch', () => {
    const assessment = assessItem(migrated('bare', [['book.m4b', 300]]));
    expect(chooseMethod(assessment, true, true)).toBe('library-scan');
    expect(chooseMethod(assessment, false, true)).toBe('records-only');
  });

  it('touches a one-file book when it may, and clears it when it may not', () => {
    const one = assessItem(migrated('b', [['01.mp3', 1]]));
    expect(chooseMethod(one, true)).toBe('touch');
    expect(chooseMethod(one, false)).toBe('clear');
  });
});

describe('trimChapters', () => {
  it('cuts a doubled chapter list back to the real length', () => {
    const doubled = [
      { id: 0, start: 0, end: 2, title: 'Dracula' },
      { id: 1, start: 2, end: 4, title: 'Dracula' },
    ];
    expect(trimChapters(doubled, 2)).toEqual([{ id: 0, start: 0, end: 2, title: 'Dracula' }]);
  });

  it('leaves chapters that already fit', () => {
    expect(trimChapters([{ id: 0, start: 0, end: 9, title: 'All' }], 9)).toBeNull();
  });
});

describe('runRepairTask', () => {
  it('reports the damage and plans a repair, writing nothing', async () => {
    migrated('double', [['01.mp3', 300], ['02.mp3', 300]]);
    healthy('fine');
    const ctx = context();

    const result = await runRepairTask(ctx);

    expect(result).toMatchObject({ scanned: 2, affected: 1, repairable: 1, repaired: 0, doubledProgress: 1 });
    expect(calls).toEqual([]);
    const rows = listRunItems(db, { runId: ctx.runId! });
    const double = rows.find((row) => row.itemId === 'double')!;
    expect(double.status).toBe('action');
    expect(double.codes).toEqual(expect.arrayContaining(['dead-audio-record', 'doubled-progress', 'rescan-one']));
    expect(double.detail).toContain('Length 20m00s → 10m00s');
    expect(double.plan).toMatchObject({ kind: 'repair', dead: ['900', '901'], live: ['100', '101'] });
    expect(rows.find((row) => row.itemId === 'fine')!.status).toBe('clean');
  });

  it('refuses to apply while the switch is off, before reading anything', async () => {
    migrated('double', [['01.mp3', 300], ['02.mp3', 300]]);
    const ctx = { ...context({ dryRun: false }), settings: DEFAULT_SETTINGS };
    await expect(runRepairTask(ctx, { apply: true })).rejects.toThrow(TRACK_REPAIR_DISABLED);
  });

  // The thing that makes "exclude" the wrong answer: the length comes back
  // right only because a live track was dropped and re-found by the rescan.
  it('mends a multi-file book over the API, and the length comes back right', async () => {
    migrated('double', [['01.mp3', 300], ['02.mp3', 300]]);
    const ctx = context({ dryRun: false });

    const result = await runRepairTask(ctx, { apply: true });

    expect(result).toMatchObject({ repaired: 1, failed: 0, methods: { 'rescan-one': 1 } });
    expect(calls).toEqual(['tracks double 100', 'scan double']);
    const after = items.get('double')!;
    expect(after.media.duration).toBe(600);
    expect(after.media.audioFiles!.map((f) => f.ino).sort()).toEqual(['100', '101']);
  });

  it('mends a one-file book it cannot touch by rebuilding its track list, and trims its chapters', async () => {
    migrated('single', [['book.mp3', 120]], {
      chapters: [
        { id: 0, start: 0, end: 120, title: 'Book' },
        { id: 1, start: 120, end: 240, title: 'Book' },
      ],
    });
    const ctx = context({ dryRun: false });

    const result = await runRepairTask(ctx, { apply: true });

    expect(result).toMatchObject({ repaired: 1, methods: { clear: 1 } });
    expect(calls).toEqual(['media single audioFiles', 'scan single', 'chapters single 1']);
    expect(items.get('single')!.media.duration).toBe(120);
    expect(items.get('single')!.media.chapters).toEqual([{ id: 0, start: 0, end: 120, title: 'Book' }]);
  });

  it('touches a one-file book when file changes are allowed, rather than emptying it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'butler-repair-'));
    try {
      const file = join(root, 'book.mp3');
      writeFileSync(file, 'audio');
      const old = new Date('2020-01-01T00:00:00Z');
      utimesSync(file, old, old);

      const item = migrated('single', [['book.mp3', 120]]);
      for (const f of [...item.media.audioFiles!, ...item.libraryFiles!]) f.metadata.path = file;
      const ctx = {
        ...context({ dryRun: false }),
        connection: { url: 'http://x', libraryRoot: root, pathPrefix: null } as TaskContext['connection'],
        settings: { ...DEFAULT_SETTINGS, allowTrackRepair: true, allowFileChanges: true },
      };
      // The fake notices a touch the way ABS does: by the file's modified time.
      const client = ctx.client as unknown as { scanItem: (id: string) => Promise<string> };
      const scan = client.scanItem;
      client.scanItem = async (id) => {
        if (statSync(file).mtimeMs > old.getTime()) touched.add('100');
        return scan(id);
      };

      const result = await runRepairTask(ctx, { apply: true });

      expect(result).toMatchObject({ repaired: 1, methods: { touch: 1 } });
      expect(calls).toEqual(['tracks single 100', 'scan single']);
      expect(items.get('single')!.media.duration).toBe(120);
      // Only the time moved; what is in the file is untouched.
      expect(statSync(file).size).toBe(5);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps an undo record holding the lists as they were, and completes it with the result', async () => {
    const before = copy(migrated('double', [['01.mp3', 300], ['02.mp3', 300]]));
    const ctx = context({ dryRun: false });

    await runRepairTask(ctx, { apply: true });

    const [revision] = listRevisions(db, ctx.runId!);
    expect(revision!.before.audioFiles).toEqual(before.media.audioFiles);
    expect(revision!.after.audioFiles!.map((f) => f.ino).sort()).toEqual(['100', '101']);
    // Nothing touched since, so revert would go ahead.
    expect(changedSince(items.get('double')!, revision!.after)).toBeNull();
    items.get('double')!.media.audioFiles!.pop();
    expect(changedSince(items.get('double')!, revision!.after)).toContain('track list');
  });

  it('reports a repair that did not take rather than claiming it', async () => {
    migrated('stuck', [['01.mp3', 300], ['02.mp3', 300]]);
    const ctx = context({ dryRun: false });
    (ctx.client as unknown as { scanItem: () => Promise<string> }).scanItem = async () => 'UPTODATE';

    const result = await runRepairTask(ctx, { apply: true });

    expect(result).toMatchObject({ repaired: 0, failed: 1 });
    const row = listRunItems(db, { runId: ctx.runId! })[0]!;
    expect(row.status).toBe('skipped');
    expect(row.detail.join(' ')).toContain('did not come back');
  });
});

/**
 * Books that are a single file at the library root, each with its old record
 * still beside the new one — the shape that reached this from a real library.
 * The files are real, in a directory of their own, so a touch has something to
 * change; and each book has inodes of its own, so touching one is not taken
 * for touching another.
 */
function bareFiles(root: string, ids: string[]): void {
  const old = new Date('2020-01-01T00:00:00Z');
  for (const [n, id] of ids.entries()) {
    const file = join(root, `${id}.m4b`);
    writeFileSync(file, 'audio');
    utimesSync(file, old, old);
    const item = migrated(id, [[`${id}.m4b`, 120]], {
      chapters: [
        { id: 0, start: 0, end: 120, title: id },
        { id: 1, start: 120, end: 240, title: id },
      ],
    });
    item.isFile = true;
    item.path = file;
    for (const f of [...item.media.audioFiles!, ...item.libraryFiles!]) {
      f.ino = `${n + 1}${f.ino}`;
      f.metadata.path = file;
    }
  }
}

/** A context that may touch files under `root`, with a scan that notices a touch the way ABS does. */
function touchingContext(root: string, options: { dryRun?: boolean; allowFileChanges?: boolean } = {}): TaskContext {
  const ctx = {
    ...context({ dryRun: options.dryRun ?? false }),
    connection: { url: 'http://x', libraryRoot: root, pathPrefix: null } as TaskContext['connection'],
    settings: { ...DEFAULT_SETTINGS, allowTrackRepair: true, allowFileChanges: options.allowFileChanges ?? true },
  };
  const client = ctx.client as unknown as { scanLibrary: (id: string) => Promise<void> };
  const scan = client.scanLibrary;
  client.scanLibrary = async (id) => {
    for (const item of items.values()) {
      for (const file of item.libraryFiles!) {
        if (!existsSync(file.metadata.path)) continue;
        if (statSync(file.metadata.path).mtimeMs > new Date('2020-01-02').getTime()) touched.add(file.ino);
      }
    }
    return scan(id);
  };
  return ctx;
}

describe('bare files at the library root', () => {
  let root: string;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'butler-bare-'));
  });
  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  it('plans a partial repair when it cannot touch the file, and says what would finish it', async () => {
    bareFiles(root, ['bare']);
    const ctx = touchingContext(root, { dryRun: true, allowFileChanges: false });

    const result = await runRepairTask(ctx);

    expect(result).toMatchObject({ affected: 1, repairable: 1, needsFileChanges: 0, methods: { 'records-only': 1 } });
    const row = listRunItems(db, { runId: ctx.runId! })[0]!;
    expect(row.status).toBe('action');
    expect(row.codes).toContain('records-only');
    expect(row.detail.join(' ')).toContain('its length stays doubled');
    expect(row.detail.join(' ')).toContain('"Allow file changes" is off');
    expect(row.plan).toMatchObject({ kind: 'repair', dead: ['1900'] });
    expect(calls).toEqual([]);
  });

  it('drops the dead record of one it cannot touch, over the API alone, and keeps its plan', async () => {
    bareFiles(root, ['bare']);
    const ctx = touchingContext(root, { allowFileChanges: false });

    const result = await runRepairTask(ctx, { apply: true });

    expect(result).toMatchObject({ repaired: 0, partlyRepaired: 1, failed: 0 });
    // No touch and no scan: the records and the chapters, and nothing else.
    expect(calls).toEqual(['tracks bare 1100', 'chapters bare 1']);
    const item = items.get('bare')!;
    expect(item.media.audioFiles!.map((f) => f.ino)).toEqual(['1100']);
    expect(item.media.chapters).toEqual([{ id: 0, start: 0, end: 120, title: 'bare' }]);
    expect(item.media.duration).toBe(240);
    expect(statSync(join(root, 'bare.m4b')).mtimeMs).toBe(new Date('2020-01-01T00:00:00Z').getTime());

    const row = listRunItems(db, { runId: ctx.runId! })[0]!;
    expect(row.status).toBe('action');
    expect(row.codes).toEqual(expect.arrayContaining(['partly-repaired', 'records-only']));
    expect(row.detail.join(' ')).toContain('Its length is still 4m00s');
    expect(countRunItemPlans(db, ctx.runId!)).toBe(1);
  });

  it('finds the doubled length a partial repair left, and finishes it once it may touch the file', async () => {
    bareFiles(root, ['bare']);
    await runRepairTask(touchingContext(root, { allowFileChanges: false }), { apply: true });

    const blocked = await runRepairTask(touchingContext(root, { dryRun: true, allowFileChanges: false }));
    expect(blocked).toMatchObject({ affected: 1, repairable: 0, needsFileChanges: 1 });

    const ctx = touchingContext(root);
    const done = await runRepairTask(ctx, { apply: true });
    expect(done).toMatchObject({ affected: 1, repaired: 1, methods: { 'library-scan': 1 } });
    expect(listRunItems(db, { runId: ctx.runId! })[0]!.codes).toContain('stale-length');
    expect(items.get('bare')!.media.duration).toBe(120);
  });

  it('plans a library scan for one when it may touch the file', async () => {
    bareFiles(root, ['bare']);
    const ctx = touchingContext(root, { dryRun: true });

    const result = await runRepairTask(ctx);

    expect(result).toMatchObject({ repairable: 1, methods: { 'library-scan': 1 } });
    const row = listRunItems(db, { runId: ctx.runId! })[0]!;
    expect(row.status).toBe('action');
    expect(row.codes).toContain('library-scan');
    expect(row.plan).toMatchObject({ kind: 'repair', dead: ['1900'], live: ['1100'] });
    expect(calls).toEqual([]);
  });

  it('mends them with one library scan between them, and trims their chapters', async () => {
    bareFiles(root, ['first', 'second']);
    migrated('folder', [['01.mp3', 300], ['02.mp3', 300]]);
    const ctx = touchingContext(root);

    const result = await runRepairTask(ctx, { apply: true });

    expect(result).toMatchObject({ repaired: 3, failed: 0, methods: { 'library-scan': 2, 'rescan-one': 1 } });
    expect(calls).toEqual([
      'tracks first 1100',
      'tracks second 2100',
      'tracks folder 100',
      'scan folder',
      'library-scan lib',
      'chapters first 1',
      'chapters second 1',
    ]);
    for (const id of ['first', 'second']) {
      expect(items.get(id)!.media.duration).toBe(120);
      expect(items.get(id)!.media.chapters).toEqual([{ id: 0, start: 0, end: 120, title: id }]);
      // Only the time moved; what is in the file is untouched.
      expect(statSync(join(root, `${id}.m4b`)).size).toBe(5);
    }
  });

  it('says what state a book is left in when the library scan fails', async () => {
    bareFiles(root, ['bare']);
    const ctx = touchingContext(root);
    (ctx.client as unknown as { scanLibrary: () => Promise<void> }).scanLibrary = async () => {
      throw new Error('503 Service Unavailable');
    };

    const result = await runRepairTask(ctx, { apply: true });

    expect(result).toMatchObject({ repaired: 0, failed: 1 });
    const row = listRunItems(db, { runId: ctx.runId! })[0]!;
    expect(row.status).toBe('skipped');
    expect(row.detail.join(' ')).toContain('the library scan failed: 503 Service Unavailable');
    expect(row.detail.join(' ')).toContain('The next scan of the library sets its length');
  });

  it('keeps the plan of a report applied while file changes are off, so it can be finished later', async () => {
    bareFiles(root, ['bare']);
    const dry = touchingContext(root, { dryRun: true });
    await runRepairTask(dry);

    const held = await runApplyTask(touchingContext(root, { allowFileChanges: false }), {
      applyFrom: dry.runId!,
      apply: true,
    });
    expect(held).toMatchObject({ written: 1, blocked: 0 });
    expect(countRunItemPlans(db, dry.runId!)).toBe(1);
    expect(calls).toEqual(['tracks bare 1100', 'chapters bare 1']);
    expect(items.get('bare')!.media.duration).toBe(240);

    // With its dead records gone, there is nothing the API alone can do.
    const still = await runApplyTask(touchingContext(root, { allowFileChanges: false }), {
      applyFrom: dry.runId!,
      apply: true,
    });
    expect(still).toMatchObject({ written: 0, blocked: 1 });
    expect(countRunItemPlans(db, dry.runId!)).toBe(1);

    const done = await runApplyTask(touchingContext(root), { applyFrom: dry.runId!, apply: true });
    expect(done).toMatchObject({ written: 1 });
    expect(items.get('bare')!.media.duration).toBe(120);
    expect(countRunItemPlans(db, dry.runId!)).toBe(0);
  });
});

describe('verifyRepair', () => {
  it('names a length that is still wrong', () => {
    const item = migrated('v', [['01.mp3', 300]]);
    const assessment = assessItem(item);
    item.media.audioFiles = item.media.audioFiles!.filter((f) => f.ino === '100');
    expect(verifyRepair(item, assessment)).toContain('10m00s');
  });
});

describe('apply of a repair run', () => {
  it('carries out the recorded repair, and finishes one whose dead records were removed by hand', async () => {
    migrated('double', [['01.mp3', 300], ['02.mp3', 300]]);
    migrated('moved-on', [['01.mp3', 300], ['02.mp3', 300]]);
    const dry = context();
    await runRepairTask(dry);

    // Somebody mends one of them by hand in between.
    items.get('moved-on')!.media.audioFiles = items.get('moved-on')!.media.audioFiles!.filter((f) => Number(f.ino) < 900);

    updateSettings(db, { allowTrackRepair: true });
    const result = await runApplyTask(
      { ...context({ dryRun: false }), settings: { ...DEFAULT_SETTINGS, allowTrackRepair: true } },
      { applyFrom: dry.runId!, apply: true },
    );

    expect(result).toMatchObject({ written: 2, unchanged: 0 });
    expect(items.get('double')!.media.duration).toBe(600);
    // Removed by hand, it kept the doubled length; the rescan is what was left.
    expect(items.get('moved-on')!.media.duration).toBe(600);
  });

  it('leaves a book whose dead records are different ones now', async () => {
    migrated('moved-on', [['01.mp3', 300], ['02.mp3', 300]]);
    const dry = context();
    await runRepairTask(dry);

    items.get('moved-on')!.media.audioFiles![0]!.ino = '555';
    const result = await runApplyTask(
      { ...context({ dryRun: false }), settings: { ...DEFAULT_SETTINGS, allowTrackRepair: true } },
      { applyFrom: dry.runId!, apply: true },
    );

    expect(result).toMatchObject({ written: 0 });
    expect(calls).toEqual([]);
  });

  it('is refused while the switch is off', async () => {
    migrated('double', [['01.mp3', 300], ['02.mp3', 300]]);
    const dry = context();
    await runRepairTask(dry);
    await expect(
      runApplyTask({ ...context({ dryRun: false }), settings: DEFAULT_SETTINGS }, { applyFrom: dry.runId!, apply: true }),
    ).rejects.toThrow(TRACK_REPAIR_DISABLED);
  });
});
