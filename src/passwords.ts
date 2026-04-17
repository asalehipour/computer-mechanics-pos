/**
 * Encrypted computer-password storage.
 *
 * Customers hand over their Windows/macOS login password at drop-off so staff
 * can log in to run diagnostics. We store it AES-256-GCM encrypted on disk,
 * auto-purge after 30 days, and log every reveal for audit.
 *
 * Key management
 * --------------
 *   Prefers env var PASSWORD_ENCRYPTION_KEY (base64 of 32 bytes). If absent,
 *   auto-generates one and persists to data/encryption.key with a warning —
 *   fine for dev; production should set the env var explicitly so the key
 *   survives filesystem wipes / container rebuilds.
 *
 * Storage
 * -------
 *   Two flat JSON files under data/, read/written atomically:
 *     data/passwords.json          — active + expired records (array)
 *     data/password-reveals.json   — append-only audit log (array)
 *   For a single-shop POS this is ample — we expect <~200 active records
 *   at any time (30-day window × job volume). Swap to Postgres when job
 *   state goes multi-tenant.
 */

import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  randomBytes,
  createCipheriv,
  createDecipheriv,
  randomUUID,
} from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { requireAuth, type SessionUser } from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const RECORDS_FILE = join(DATA_DIR, 'passwords.json');
const REVEALS_FILE = join(DATA_DIR, 'password-reveals.json');
const KEY_FILE = join(DATA_DIR, 'encryption.key');

const RETENTION_DAYS = 30;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;
// How long to keep audit log entries (longer than record retention so we
// retain the "who accessed what" trail even after the secret itself is gone).
const AUDIT_RETENTION_DAYS = 365;
const AUDIT_RETENTION_MS = AUDIT_RETENTION_DAYS * 24 * 60 * 60 * 1000;

// ── Types ────────────────────────────────────────────────────────────────

export interface PasswordRecord {
  id: string;
  jobId: string;
  contactId: string | null;
  customerEmail: string;
  customerName: string;
  /** Base64 AES-256-GCM IV (12 bytes). */
  iv: string;
  /** Base64 AES-256-GCM ciphertext. */
  ciphertext: string;
  /** Base64 AES-256-GCM auth tag (16 bytes). */
  tag: string;
  createdAt: string;
  expiresAt: string;
  createdBy: { name: string; email: string };
}

export interface RevealEntry {
  id: string;
  recordId: string;
  revealedAt: string;
  revealedBy: { name: string; email: string };
  customerEmail: string;
  customerName: string;
  jobId: string;
  reason: string;
}

/** Safe metadata for listing records (no ciphertext). */
export interface PasswordRecordMeta {
  id: string;
  jobId: string;
  contactId: string | null;
  customerEmail: string;
  customerName: string;
  createdAt: string;
  expiresAt: string;
  createdBy: { name: string; email: string };
  expired: boolean;
}

// ── Key management ───────────────────────────────────────────────────────

let keyCache: Buffer | null = null;

async function ensureDir(): Promise<void> {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
}

async function loadKey(): Promise<Buffer> {
  if (keyCache) return keyCache;

  const fromEnv = process.env.PASSWORD_ENCRYPTION_KEY;
  if (fromEnv) {
    const buf = Buffer.from(fromEnv, 'base64');
    if (buf.length !== 32) {
      throw new Error(
        `PASSWORD_ENCRYPTION_KEY must be 32 bytes base64-encoded (got ${buf.length} bytes)`,
      );
    }
    keyCache = buf;
    return buf;
  }

  await ensureDir();
  if (existsSync(KEY_FILE)) {
    const raw = await readFile(KEY_FILE);
    if (raw.length !== 32) {
      throw new Error(
        `${KEY_FILE} must contain exactly 32 bytes (got ${raw.length})`,
      );
    }
    keyCache = raw;
    return raw;
  }

  // First-run: auto-generate. Log loudly so operators notice.
  const generated = randomBytes(32);
  const tmp = KEY_FILE + '.tmp';
  await writeFile(tmp, generated, { mode: 0o600 });
  await rename(tmp, KEY_FILE);
  console.warn(
    '[passwords] Generated new AES-256 key at data/encryption.key — ' +
      'set PASSWORD_ENCRYPTION_KEY (base64) in production so the key survives redeploys.',
  );
  keyCache = generated;
  return generated;
}

// ── Encryption primitives ────────────────────────────────────────────────

interface EncryptedBundle {
  iv: string;
  ciphertext: string;
  tag: string;
}

async function encrypt(plaintext: string): Promise<EncryptedBundle> {
  const key = await loadKey();
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  return {
    iv: iv.toString('base64'),
    ciphertext: encrypted.toString('base64'),
    tag: tag.toString('base64'),
  };
}

async function decrypt(bundle: EncryptedBundle): Promise<string> {
  const key = await loadKey();
  const iv = Buffer.from(bundle.iv, 'base64');
  const ciphertext = Buffer.from(bundle.ciphertext, 'base64');
  const tag = Buffer.from(bundle.tag, 'base64');
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAuthTag(tag);
  const plaintext = Buffer.concat([
    decipher.update(ciphertext),
    decipher.final(),
  ]);
  return plaintext.toString('utf8');
}

// ── File IO ──────────────────────────────────────────────────────────────

async function readJsonArray<T>(path: string): Promise<T[]> {
  if (!existsSync(path)) return [];
  try {
    const raw = await readFile(path, 'utf8');
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch (err) {
    console.error(`[passwords] Failed to parse ${path}, treating as empty:`, err);
    return [];
  }
}

async function writeJsonAtomic<T>(path: string, data: T[]): Promise<void> {
  await ensureDir();
  const tmp = path + '.tmp';
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, path);
}

// Simple per-file serializer so concurrent writes don't clobber each other.
const writeQueues = new Map<string, Promise<void>>();

function queueWrite(path: string, fn: () => Promise<void>): Promise<void> {
  const prev = writeQueues.get(path) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  writeQueues.set(path, next);
  return next;
}

async function loadRecords(): Promise<PasswordRecord[]> {
  return readJsonArray<PasswordRecord>(RECORDS_FILE);
}

async function saveRecords(records: PasswordRecord[]): Promise<void> {
  return queueWrite(RECORDS_FILE, () => writeJsonAtomic(RECORDS_FILE, records));
}

async function loadReveals(): Promise<RevealEntry[]> {
  return readJsonArray<RevealEntry>(REVEALS_FILE);
}

async function saveReveals(entries: RevealEntry[]): Promise<void> {
  return queueWrite(REVEALS_FILE, () => writeJsonAtomic(REVEALS_FILE, entries));
}

// ── Public API (backend) ─────────────────────────────────────────────────

function toMeta(r: PasswordRecord): PasswordRecordMeta {
  return {
    id: r.id,
    jobId: r.jobId,
    contactId: r.contactId,
    customerEmail: r.customerEmail,
    customerName: r.customerName,
    createdAt: r.createdAt,
    expiresAt: r.expiresAt,
    createdBy: r.createdBy,
    expired: new Date(r.expiresAt).getTime() <= Date.now(),
  };
}

export interface SavePasswordInput {
  plaintext: string;
  jobId: string;
  contactId: string | null;
  customerEmail: string;
  customerName: string;
  createdBy: { name: string; email: string };
}

/** Encrypts and persists a password record. Returns the record id. */
export async function savePassword(input: SavePasswordInput): Promise<string> {
  const trimmed = input.plaintext.trim();
  if (!trimmed) throw new Error('Password cannot be empty.');

  const bundle = await encrypt(trimmed);
  const now = new Date();
  const record: PasswordRecord = {
    id: randomUUID(),
    jobId: input.jobId,
    contactId: input.contactId,
    customerEmail: input.customerEmail,
    customerName: input.customerName,
    iv: bundle.iv,
    ciphertext: bundle.ciphertext,
    tag: bundle.tag,
    createdAt: now.toISOString(),
    expiresAt: new Date(now.getTime() + RETENTION_MS).toISOString(),
    createdBy: input.createdBy,
  };

  const records = await loadRecords();
  records.push(record);
  await saveRecords(records);
  return record.id;
}

/**
 * Decrypts a record and appends an audit entry. Throws if the record is
 * missing, expired, or decryption fails (tamper / wrong key).
 */
export async function revealPassword(
  recordId: string,
  revealedBy: { name: string; email: string },
  reason: string,
): Promise<{ plaintext: string; record: PasswordRecordMeta }> {
  if (!reason.trim()) throw new Error('Reason is required for reveal.');

  const records = await loadRecords();
  const record = records.find(r => r.id === recordId);
  if (!record) throw new Error('not_found');
  if (new Date(record.expiresAt).getTime() <= Date.now()) {
    throw new Error('expired');
  }

  const plaintext = await decrypt(record);

  const entry: RevealEntry = {
    id: randomUUID(),
    recordId,
    revealedAt: new Date().toISOString(),
    revealedBy,
    customerEmail: record.customerEmail,
    customerName: record.customerName,
    jobId: record.jobId,
    reason: reason.trim(),
  };
  const reveals = await loadReveals();
  reveals.push(entry);
  await saveReveals(reveals);

  return { plaintext, record: toMeta(record) };
}

export async function listRecordsForContact(
  contactId: string,
): Promise<PasswordRecordMeta[]> {
  const records = await loadRecords();
  return records
    .filter(r => r.contactId === contactId)
    .map(toMeta)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listRecordsForEmail(
  email: string,
): Promise<PasswordRecordMeta[]> {
  const lc = email.trim().toLowerCase();
  if (!lc) return [];
  const records = await loadRecords();
  return records
    .filter(r => r.customerEmail.toLowerCase() === lc)
    .map(toMeta)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listAllRecords(): Promise<PasswordRecordMeta[]> {
  const records = await loadRecords();
  return records.map(toMeta).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

export async function listReveals(): Promise<RevealEntry[]> {
  const reveals = await loadReveals();
  return [...reveals].sort((a, b) => b.revealedAt.localeCompare(a.revealedAt));
}

/** Deletes records past their expiry and prunes very old audit entries. */
export async function purgeExpired(): Promise<{ removedRecords: number; removedReveals: number }> {
  const now = Date.now();
  const records = await loadRecords();
  const kept = records.filter(r => new Date(r.expiresAt).getTime() > now);
  const removedRecords = records.length - kept.length;
  if (removedRecords > 0) await saveRecords(kept);

  const reveals = await loadReveals();
  const auditCutoff = now - AUDIT_RETENTION_MS;
  const keptReveals = reveals.filter(r => new Date(r.revealedAt).getTime() > auditCutoff);
  const removedReveals = reveals.length - keptReveals.length;
  if (removedReveals > 0) await saveReveals(keptReveals);

  return { removedRecords, removedReveals };
}

let purgeTimer: NodeJS.Timeout | null = null;

/** Run purge once at startup and then every hour. */
export function startPurgeTimer(): void {
  if (purgeTimer) return;
  const run = () => {
    void purgeExpired()
      .then(({ removedRecords, removedReveals }) => {
        if (removedRecords || removedReveals) {
          console.log(
            `[passwords] Purged ${removedRecords} expired record(s) and ${removedReveals} old audit entries.`,
          );
        }
      })
      .catch(err => console.error('[passwords] Purge failed:', err));
  };
  run();
  purgeTimer = setInterval(run, 60 * 60 * 1000);
  purgeTimer.unref();
}

// ── Fastify routes ───────────────────────────────────────────────────────

export function registerPasswordRoutes(app: FastifyInstance): void {
  // Metadata listings — safe to return without audit entries.
  app.get('/api/password/records', { preHandler: requireAuth }, async () => {
    return { records: await listAllRecords() };
  });

  app.get('/api/password/reveals', { preHandler: requireAuth }, async () => {
    return { entries: await listReveals() };
  });

  app.get<{ Params: { contactId: string } }>(
    '/api/password/for-contact/:contactId',
    { preHandler: requireAuth },
    async (req) => {
      const records = await listRecordsForContact(req.params.contactId);
      return { records };
    },
  );

  app.get<{ Querystring: { email?: string } }>(
    '/api/password/for-email',
    { preHandler: requireAuth },
    async (req) => {
      const email = (req.query?.email ?? '').toString();
      return { records: await listRecordsForEmail(email) };
    },
  );

  app.post<{ Params: { recordId: string }; Body: { reason?: string } }>(
    '/api/password/reveal/:recordId',
    { preHandler: requireAuth },
    async (req, reply) => {
      const user = req.session.get('user') as SessionUser | undefined;
      if (!user) return reply.code(401).send({ ok: false, error: 'not_authenticated' });
      const reason = (req.body?.reason ?? '').toString();
      if (!reason.trim()) {
        return reply.code(400).send({ ok: false, error: 'reason_required' });
      }
      try {
        const { plaintext, record } = await revealPassword(
          req.params.recordId,
          { name: user.name, email: user.email },
          reason,
        );
        return { ok: true, plaintext, record };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        const code = msg === 'not_found' ? 404 : msg === 'expired' ? 410 : 500;
        return reply.code(code).send({ ok: false, error: msg });
      }
    },
  );
}
