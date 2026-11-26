/**
 * All-or-nothing startup. Anything started before a later step throws (the
 * pricing/FX refresh timers, the DuckDB handle, the config watcher…) is torn
 * down again, and nothing the attempt registered on `subscriptions` is left
 * behind — a failed activation must not leak live timers and file handles into
 * the rest of the window's lifetime.
 */
import { defaultLogger, Logger } from '../util/logger';

export async function withStartupRollback<T>(
  subscriptions: Array<{ dispose(): unknown }>,
  startup: (started: Array<() => void>) => Promise<T>,
  logger: Logger = defaultLogger,
): Promise<T> {
  const subscriptionsAtStart = subscriptions.length;
  const started: Array<() => void> = [];
  try {
    return await startup(started);
  } catch (err) {
    const leaked = subscriptions.splice(subscriptionsAtStart);
    for (const dispose of [...started.reverse(), ...leaked.reverse().map((d) => () => void d.dispose())]) {
      try {
        dispose();
      } catch (disposeErr) {
        logger.warn('container', 'cleanup after failed startup threw', disposeErr);
      }
    }
    throw err;
  }
}
