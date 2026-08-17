/**
 * Suppresses Node's ExperimentalWarning for node:sqlite.
 *
 * This lives in its own module, and must be the FIRST import of any entry
 * point, because ES module imports are hoisted and evaluated before any
 * statement in the importing file — so patching inside db/index.ts would run
 * only after `node:sqlite` had already been loaded and warned.
 *
 * Only the SQLite notice is filtered; every other warning still surfaces.
 */
const original = process.emitWarning.bind(process);

process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
  const text = typeof warning === 'string' ? warning : warning?.message ?? '';
  if (text.includes('SQLite is an experimental feature')) return;
  return (original as (...a: unknown[]) => void)(warning, ...args);
}) as typeof process.emitWarning;

export {};
