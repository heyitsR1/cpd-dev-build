// backup-schedule.js — when an automatic backup is due. Pure, so it can be
// tested without chrome.*; background.js asks it once an hour.

export const SCHEDULE_MS = { daily: 24 * 60 * 60 * 1000, weekly: 7 * 24 * 60 * 60 * 1000 };
// A failed automatic run (signed out, offline) is retried this much later, not
// every hour — no point hitting the account's API from a laptop that's offline.
export const AUTO_RETRY_MS = 6 * 60 * 60 * 1000;
// A run whose page died with the browser never reports back.
export const STALE_RUN_MS = 2 * 60 * 60 * 1000;

/**
 * @param {{settings?: {schedule?: string}, lastBackup?: {at: number},
 *          lastBackupError?: {at: number}, run?: {running: boolean, startedAt: number}}} state
 */
export function autoBackupDue(state, now = Date.now()) {
  const { settings, lastBackup, lastBackupError, run } = state || {};
  const every = SCHEDULE_MS[settings && settings.schedule];
  if (!every) return false;
  if (run && run.running && now - (run.startedAt || 0) < STALE_RUN_MS) return false;
  if (lastBackupError && now - (lastBackupError.at || 0) < AUTO_RETRY_MS) return false;
  return now - ((lastBackup && lastBackup.at) || 0) >= every;
}

export function isRunLive(run, now = Date.now()) {
  return !!(run && run.running && now - (run.startedAt || 0) < STALE_RUN_MS);
}
