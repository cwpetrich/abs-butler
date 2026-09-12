/**
 * The one place the version is written by hand.
 *
 * It was in five, and the update check made that dangerous rather than untidy:
 * a stale copy there reports a release that does not exist, or hides one that
 * does. version.test.ts fails when this and package.json disagree, so the
 * duplication cannot drift even though it still exists.
 *
 * The web UI takes it from the API rather than carrying its own copy.
 */
export const VERSION = '0.7.0';
