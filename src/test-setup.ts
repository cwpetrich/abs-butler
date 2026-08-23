import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Every test run gets its own data directory.
 *
 * The encryption key generates itself on first use, and without this it would
 * land in ./data/secret.key inside the repository — and be shared between
 * tests that each expect a fresh one.
 */
process.env.BUTLER_DATA_DIR = mkdtempSync(join(tmpdir(), 'abs-butler-test-'));
delete process.env.BUTLER_SECRET;
delete process.env.BUTLER_SETUP_CODE;
