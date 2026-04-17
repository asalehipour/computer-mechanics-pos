import Fastify from 'fastify';
import fastifyStatic from '@fastify/static';
import fastifyCookie from '@fastify/cookie';
import fastifySecureSession from '@fastify/secure-session';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { config, isProd } from './config.js';
import { registerAuth, requireAuth, requireAdmin, isAdmin, type SessionUser } from './auth.js';
import { createBackupBuffer, restoreFromBuffer, backupSummary } from './backup.js';
import { registerSettings } from './settings.js';
import { registerWebSocket } from './ws.js';
import { registerPasswordRoutes, startPurgeTimer } from './passwords.js';
import { initJobBoard, searchCustomers, readAttachmentBytes } from './job-board.js';
import { initCounter } from './counter.js';

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
  // Force revalidation on every request. Without this, fastify-static sends
  // Cache-Control: max-age=14400 which means browsers serve a stale copy of
  // customer.js / staff.js for up to 4 hours after a deploy — the user sees
  // "I pushed but nothing changed" until they hard-refresh. With no-cache the
  // browser still revalidates via ETag (304 when unchanged) so the network
  // cost is trivial, and every deploy lands instantly.
  cacheControl: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-cache');
  },
});

registerAuth(app);
registerSettings(app);
registerPasswordRoutes(app);
startPurgeTimer();
await initJobBoard();
initCounter();
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

// ── Backup / restore (admin-only) ────────────────────────────────────────
// Expose to the Settings UI for ad-hoc backups, plus a summary endpoint the
// page uses to show current data-dir size. Restore is gated behind a typed
// confirmation phrase because it wipes all jobs, passwords and attachments.

/** Whether the current session can see the backup panel at all. */
app.get('/api/admin/status', { preHandler: requireAuth }, async (req) => {
  const user = req.session.get('user') as SessionUser | undefined;
  return { isAdmin: isAdmin(user) };
});

app.get('/api/admin/backup/summary', { preHandler: requireAdmin }, async () => {
  return await backupSummary();
});

app.get('/api/admin/backup', { preHandler: requireAdmin }, async (_req, reply) => {
  const buf = await createBackupBuffer();
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  reply
    .header('Content-Type', 'application/zip')
    .header('Content-Length', String(buf.length))
    .header('Content-Disposition', `attachment; filename="pos-backup-${stamp}.zip"`);
  return reply.send(buf);
});

// Accept raw zip bodies on the restore endpoint. Registered at route scope
// so we don't affect any other route's parsing.
app.addContentTypeParser(
  'application/zip',
  { parseAs: 'buffer' },
  (_req, body, done) => { done(null, body); },
);

app.post<{ Querystring: { confirm?: string } }>(
  '/api/admin/restore',
  { preHandler: requireAdmin, bodyLimit: 500 * 1024 * 1024 }, // 500 MB ceiling
  async (req, reply) => {
    if (req.query.confirm !== 'RESTORE') {
      return reply.code(400).send({ error: 'missing_confirmation', detail: 'Pass ?confirm=RESTORE to proceed.' });
    }
    const body = req.body;
    if (!Buffer.isBuffer(body)) {
      return reply.code(400).send({ error: 'bad_body', detail: 'Expected a raw zip body (application/zip).' });
    }
    try {
      const result = await restoreFromBuffer(body);
      req.log.warn({ fileCount: result.fileCount }, '[admin] Restored from backup — restart recommended');
      return { ok: true, ...result, note: 'Restore complete. Restart the server to reload in-memory caches.' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      req.log.error({ err }, '[admin] Restore failed');
      return reply.code(400).send({ error: 'restore_failed', detail: msg });
    }
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
