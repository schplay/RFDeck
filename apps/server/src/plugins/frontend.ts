import fp from 'fastify-plugin';
import fastifyStatic from '@fastify/static';
import fs from 'fs';
import path from 'path';
import { log } from '../logger';

// Serve the built web UI.
//
// Without this the server is API-only and browsing to it returns 404 — which
// makes a headless deployment useless, since the whole point is that people on
// the venue network open it in a browser.
//
// The desktop build loads the same files straight off disk instead, so this is
// a no-op there when the build is not adjacent.

function resolveWebRoot(): string | null {
  const candidates = [
    // Explicit override, for a deployment that puts the UI elsewhere.
    process.env.WEB_ROOT,
    // Normal layout: apps/server/dist/plugins -> apps/web/dist
    path.resolve(__dirname, '../../../web/dist'),
    // Server copied next to the UI (some packaging layouts)
    path.resolve(__dirname, '../../web'),
  ].filter(Boolean) as string[];

  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) return dir;
  }
  return null;
}

export default fp(async (fastify) => {
  const root = resolveWebRoot();

  if (!root) {
    log.warn(
      'Web UI build not found — serving API only. ' +
      'Run `pnpm --filter @rfdeck/web build`, or set WEB_ROOT to the built UI.'
    );
    return;
  }

  log.info(`Serving web UI from ${root}`);

  await fastify.register(fastifyStatic, {
    root,
    // Cache-Control is applied by the hook below rather than by the plugin, so
    // the rule is the same whether a file is served directly or as the SPA
    // fallback.
    cacheControl: false,
  });

  // Vite emits content-hashed asset filenames, so those are safe to cache
  // indefinitely. index.html must never be cached, or a client keeps booting
  // the previous bundle after an upgrade and appears not to have updated.
  fastify.addHook('onSend', async (request, reply) => {
    const url = request.url.split('?')[0];
    if (url.startsWith('/api') || url.startsWith('/socket.io')) return;

    if (url.startsWith('/assets/')) {
      reply.header('Cache-Control', 'public, max-age=31536000, immutable');
    } else {
      reply.header('Cache-Control', 'no-cache');
    }
  });

  // Single-page app: any non-API path that isn't a real file is a client-side
  // route, so hand back index.html and let the router deal with it.
  fastify.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith('/api') || request.url.startsWith('/socket.io')) {
      return reply.code(404).send({ error: 'Not found' });
    }
    return reply.sendFile('index.html');
  });
});
