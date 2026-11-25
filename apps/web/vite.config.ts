import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
import { fileURLToPath } from 'node:url';

/** The repo root (this worktree) holds the per-worktree `.env` — see docs/WORKTREES.md and `.env.example`. */
const root = fileURLToPath(new URL('../..', import.meta.url));

export default defineConfig(({ mode }) => {
  const env = { ...loadEnv(mode, root, ''), ...process.env };
  const webPort = Number(env.WEB_PORT) || 5173;
  const apiPort = Number(env.API_PORT) || 4000;
  return {
    plugins: [react(), tailwindcss()],
    envDir: root,
    resolve: {
      alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
    },
    server: {
      port: webPort,
      strictPort: true, // another worktree's web server on this port is a configuration error, not something to hop over
      proxy: {
        '/api': { target: `http://localhost:${apiPort}`, changeOrigin: true },
      },
    },
  };
});
