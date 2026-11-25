import { logger } from './logger';
import { startDevMongo } from './devMongo';

/**
 * `npm run mongo` (root) — keep the shared local MongoDB running on its own, so several worktrees' API servers and
 * seeds come and go without one of them owning the database process (docs/WORKTREES.md). Ctrl-C stops it.
 */
async function main() {
  const { uri, stop } = await startDevMongo();
  logger.info({ uri: uri.replace(/\/[a-z0-9_]+\?/, '/<db>?') }, 'shared local MongoDB ready for every worktree — Ctrl-C stops it');
  const shutdown = async (signal: string) => {
    logger.info({ signal }, 'stopping the shared local MongoDB');
    await stop().catch(() => {});
    process.exit(0);
  };
  process.once('SIGINT', () => void shutdown('SIGINT'));
  process.once('SIGTERM', () => void shutdown('SIGTERM'));
  setInterval(() => {}, 60_000); // stay alive
}
main().catch((err) => {
  logger.error({ err }, 'failed to start the shared local MongoDB');
  process.exit(1);
});
