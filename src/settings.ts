import type { FastifyInstance } from 'fastify';
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { getXeroClient, resetXeroStubState } from './integrations/xero.js';
import { getTyroClient } from './integrations/tyro.js';
import { getEmailClient } from './integrations/email.js';
import { clearAuditLog, getAuditLog } from './integrations/audit.js';
import { requireAuth } from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const SETTINGS_FILE = join(DATA_DIR, 'settings.json');

interface IntegrationFlag {
  /** Whether this integration has a live client configured. Disabled in UI until creds exist. */
  useLive: boolean;
  /** Free-text notes shown in UI */
  note?: string;
}

export interface Settings {
  version: 1;
  flags: {
    customerPasswordField: { show: boolean };
    reviewEmail: { sendOnPickup: boolean; delayMinutes: number };
  };
  integrations: {
    xero: IntegrationFlag;
    tyro: IntegrationFlag;
    email: IntegrationFlag;
  };
}

const DEFAULTS: Settings = {
  version: 1,
  flags: {
    customerPasswordField: { show: true },
    reviewEmail: { sendOnPickup: false, delayMinutes: 30 },
  },
  integrations: {
    xero:  { useLive: false, note: 'Waiting on Xero OAuth credentials' },
    tyro:  { useLive: false, note: 'Waiting on Tyro partner SDK files' },
    email: { useLive: false, note: 'SMTP not configured' },
  },
};

let cached: Settings | null = null;

async function ensureDir(): Promise<void> {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
}

async function loadFromDisk(): Promise<Settings> {
  await ensureDir();
  if (!existsSync(SETTINGS_FILE)) {
    await writeFile(SETTINGS_FILE, JSON.stringify(DEFAULTS, null, 2));
    return structuredClone(DEFAULTS);
  }
  try {
    const raw = await readFile(SETTINGS_FILE, 'utf8');
    const parsed = JSON.parse(raw);
    // Shallow merge against DEFAULTS so newly-added keys get sensible values
    return {
      ...DEFAULTS,
      ...parsed,
      flags: { ...DEFAULTS.flags, ...(parsed.flags ?? {}) },
      integrations: { ...DEFAULTS.integrations, ...(parsed.integrations ?? {}) },
    } as Settings;
  } catch (err) {
    // Corrupted settings — fall back to defaults but don't overwrite the bad file
    // so the user can inspect it.
    console.error('Failed to parse settings.json, using defaults:', err);
    return structuredClone(DEFAULTS);
  }
}

async function saveToDisk(settings: Settings): Promise<void> {
  await ensureDir();
  const tmp = SETTINGS_FILE + '.tmp';
  await writeFile(tmp, JSON.stringify(settings, null, 2));
  await rename(tmp, SETTINGS_FILE);
}

export async function getSettings(): Promise<Settings> {
  if (!cached) cached = await loadFromDisk();
  return cached;
}

type PartialSettings = {
  flags?: Partial<Settings['flags']>;
  integrations?: Partial<Settings['integrations']>;
};

export async function updateSettings(patch: PartialSettings): Promise<Settings> {
  const current = await getSettings();
  const next: Settings = {
    ...current,
    flags: { ...current.flags, ...(patch.flags ?? {}) },
    integrations: { ...current.integrations, ...(patch.integrations ?? {}) },
  };
  await saveToDisk(next);
  cached = next;
  return next;
}

// ── Routes ──────────────────────────────────────────────────────────────────
export function registerSettings(app: FastifyInstance) {
  app.get('/api/settings', { preHandler: requireAuth }, async () => {
    return await getSettings();
  });

  app.put('/api/settings', { preHandler: requireAuth }, async (req, reply) => {
    const body = (req.body ?? {}) as PartialSettings;
    if (typeof body !== 'object' || body === null) {
      return reply.code(400).send({ error: 'invalid_body' });
    }
    const updated = await updateSettings(body);
    return updated;
  });

  app.post('/api/integrations/:name/test', { preHandler: requireAuth }, async (req, reply) => {
    const name = String((req.params as { name?: string }).name ?? '').toLowerCase();
    try {
      switch (name) {
        case 'xero':  return await getXeroClient().ping();
        case 'tyro':  return await getTyroClient().ping();
        case 'email': return await getEmailClient().ping();
        default:      return reply.code(404).send({ error: 'unknown_integration', name });
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return reply.code(500).send({ ok: false, error: message });
    }
  });

  app.get('/api/audit', { preHandler: requireAuth }, async () => {
    return { entries: getAuditLog() };
  });

  app.delete('/api/audit', { preHandler: requireAuth }, async () => {
    clearAuditLog();
    return { ok: true };
  });

  app.post('/api/dev/reset-stubs', { preHandler: requireAuth }, async () => {
    resetXeroStubState();
    clearAuditLog();
    return { ok: true, message: 'Stub state cleared' };
  });
}
