import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifySecureSession from '@fastify/secure-session';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config, isProd } from './config.js';
import { registerAuth, requireAuth } from './auth.js';
import { registerSettings } from './settings.js';
import { registerWebSocket } from './ws.js';
import { registerPasswordRoutes, startPurgeTimer } from './passwords.js';
import { initJobBoard, searchCustomers, readAttachmentBytes } from './job-board.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const publicDir = join(__dirname, '..', 'public');
const assetsDir = join(publicDir, 'assets');

const app = Fastify({
  logger: { level: isProd ? 'info' : 'debug' },
  trustProxy: true,
});

await app.register(fastifyCookie);
await app.register(fastifySecureSession, {
  secret: config.sessionSecret,
  salt: 'cm-pos-v1-salt01', // must be exactly 16 bytes
  cookieName: 'cm_session',
  cookie: {
    path: '/',
    httpOnly: true,
    secure: isProd,
    sameSite: 'lax',
    maxAge: 60 * 60 * 12, // 12h
  },
});

// Serve /assets/* from public/assets/ — CSS/JS/images only; HTML stays in public/ root
// and is only reachable through protected route handlers below.
await app.register(fastifyStatic, {
  root: assetsDir,
  prefix: '/assets/',
});

registerAuth(app);
registerSettings(app);
registerPasswordRoutes(app);
startPurgeTimer();
await initJobBoard();
await registerWebSocket(app);

app.get('/', async (_req, reply) => {
  return reply.sendFile('index.html', publicDir);
});

app.get('/staff', { preHandler: requireAuth }, async (_req, reply) => {
  return reply.sendFile('staff.html', publicDir);
});

app.get('/staff/board', { preHandler: requireAuth }, async (_req, reply) => {
  return reply.sendFile('staff-board.html', publicDir);
});

app.get('/customer', { preHandler: requireAuth }, async (_req, reply) => {
  return reply.sendFile('customer.html', publicDir);
});

app.get('/settings', { preHandler: requireAuth }, async (_req, reply) => {
  return reply.sendFile('settings.html', publicDir);
});

app.get<{ Querystring: { q?: string } }>('/api/customers/search', { preHandler: requireAuth }, async (req) => {
  const q = String(req.query.q ?? '').trim();
  if (!q) return { results: [] };
  return { results: searchCustomers(q, 8) };
});

// Download or view an attachment PDF. `?inline=1` streams with
// Content-Disposition: inline so the browser renders it in a new tab;
// otherwise it's served as an attachment (forced download).
app.get<{ Params: { entryId: string; attachmentId: string }; Querystring: { inline?: string } }>(
  '/api/board/:entryId/attachments/:attachmentId',
  { preHandler: requireAuth },
  async (req, reply) => {
    const { entryId, attachmentId } = req.params;
    const result = await readAttachmentBytes(entryId, attachmentId);
    if (!result) return reply.code(404).send({ error: 'not_found' });
    const disposition = req.query.inline ? 'inline' : 'attachment';
    reply
      .header('Content-Type', 'application/pdf')
      .header('Content-Length', String(result.bytes.length))
      .header('Content-Disposition', `${disposition}; filename="${result.meta.filename}"`);
    return reply.send(result.bytes);
  },
);

app.get('/health', async () => ({ ok: true, ts: Date.now() }));

try {
  await app.listen({ port: config.port, host: '0.0.0.0' });
  app.log.info(`Computer Mechanics POS ready at ${config.publicBaseUrl}`);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}
