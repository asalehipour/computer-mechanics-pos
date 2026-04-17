/**
 * Monotonically-increasing display number for job cards ("#1051", "#1052", …).
 *
 * The raw job id (randomUUID / shortId) is fine for internal bookkeeping but
 * customers want human numbers to quote over the phone. We store a single
 * counter in data/counters.json and hand out the next value each time a new
 * job is started. The number is embedded into the Job and the BoardEntry so
 * receipts, emails and the drawer header all line up.
 *
 * Starting value is 1050 — deliberately not 1 so it doesn't look like this
 * is a brand-new system to anyone we quote a number to. The first job ever
 * started will be #1051 (nextJobNumber increments before returning).
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const COUNTERS_FILE = join(DATA_DIR, 'counters.json');

const STARTING_JOB_NUMBER = 1050;

interface CountersFile {
  lastJobNumber: number;
}

let state: CountersFile | null = null;

function ensureDir(): void {
  if (!existsSync(DATA_DIR)) mkdirSync(DATA_DIR, { recursive: true });
}

function load(): CountersFile {
  if (state) return state;
  ensureDir();
  if (existsSync(COUNTERS_FILE)) {
    try {
      const raw = readFileSync(COUNTERS_FILE, 'utf8');
      const parsed = JSON.parse(raw) as Partial<CountersFile>;
      const n = Number(parsed.lastJobNumber);
      state = { lastJobNumber: Number.isFinite(n) && n >= STARTING_JOB_NUMBER ? n : STARTING_JOB_NUMBER };
      return state;
    } catch (err) {
      console.error('[counter] Failed to parse counters.json, resetting:', err);
    }
  }
  state = { lastJobNumber: STARTING_JOB_NUMBER };
  persist();
  return state;
}

function persist(): void {
  if (!state) return;
  ensureDir();
  const tmp = COUNTERS_FILE + '.tmp';
  writeFileSync(tmp, JSON.stringify(state, null, 2));
  renameSync(tmp, COUNTERS_FILE);
}

/**
 * Returns the next job number and persists it. Synchronous because the call
 * sites (startNewJob) already return synchronously to the WS handler — the
 * file write is cheap and atomic (rename over tmp).
 */
export function nextJobNumber(): number {
  const s = load();
  s.lastJobNumber += 1;
  persist();
  return s.lastJobNumber;
}

/** Peek at the most recently-assigned number (for /api/admin or tests). */
export function currentJobNumber(): number {
  return load().lastJobNumber;
}

/** Cold-path init so the counter file exists on first boot. */
export function initCounter(): void {
  load();
}
