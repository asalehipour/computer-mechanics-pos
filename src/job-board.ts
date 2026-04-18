/**
 * Job Board — built-in kanban for tracking every checked-out job.
 *
 * Every completed checkout creates a BoardEntry. Staff drag cards between
 * columns (status), leave comments, and eventually move them to
 * "Done / Collected" when the customer picks up. Persisted to a single JSON
 * file; broadcast to all staff connections via the existing WebSocket.
 *
 * Keep it flat: a single `data/job-board.json` with all entries is fine for
 * a single-shop POS (expect <~200 open jobs). When we go multi-tenant, swap
 * this module for a Postgres-backed equivalent.
 */

import { readFile, writeFile, mkdir, rename, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');
const BOARD_FILE = join(DATA_DIR, 'job-board.json');
const ATTACHMENTS_DIR = join(DATA_DIR, 'attachments');

// ── Types ────────────────────────────────────────────────────────────────

/** The eight board columns, in display order. */
export const BOARD_STATUSES = [
  'booked_in',
  'in_progress',
  'waiting_parts',
  'waiting_customer',
  'waiting_third_party',
  'ready_for_collection',
  'done_collected',
  'on_the_spot',
] as const;
export type BoardStatus = (typeof BOARD_STATUSES)[number];

export function isBoardStatus(x: unknown): x is BoardStatus {
  return typeof x === 'string' && (BOARD_STATUSES as readonly string[]).includes(x);
}

export type BoardFlow = 'repair' | 'product' | 'on_the_spot' | 'pickup';

/** Where the device is during the job — mirrors DeviceIntent in job.ts. */
export type BoardDeviceIntent = 'taking' | 'leaving' | 'na';

export function isBoardDeviceIntent(x: unknown): x is BoardDeviceIntent {
  return x === 'taking' || x === 'leaving' || x === 'na';
}

export interface BoardComment {
  id: string;
  author: { name: string; email: string };
  body: string;
  createdAt: string;
  /** Set on edit. If present, UI shows "(edited)" next to the timestamp. */
  editedAt?: string;
}

export interface BoardPart {
  id: string;
  /** User-typed name, e.g. "LCD screen for Envy x360 15-EY". */
  name: string;
  /** Raw URL as pasted (e.g. ebay order detail page). Rendered as a link. */
  url: string;
  /** Pretty domain derived from url (e.g. "ebay.com.au"). Empty if url was bad. */
  domain: string;
  addedBy: { name: string; email: string };
  createdAt: string;
  /**
   * Arrival status. Absent/`"in_transit"` = ordered and on the way;
   * `"arrived"` = staff marked the part received. We keep arrived parts
   * on the card so the drawer can show "Arrived" bubbles instead of the
   * part silently disappearing.
   */
  status?: 'in_transit' | 'arrived';
  /** ISO timestamp when the part was marked arrived. */
  arrivedAt?: string;
  /** Who marked it arrived. */
  arrivedBy?: { name: string; email: string };
}

/**
 * A PDF attached to a job card — either the job receipt we generate at
 * checkout, or an invoice PDF pulled from Xero. Bytes live on disk under
 * `data/attachments/<entryId>/<id>.pdf`; this record is just metadata.
 */
export type BoardAttachmentKind = 'receipt' | 'invoice';

export interface BoardAttachment {
  id: string;
  kind: BoardAttachmentKind;
  /** Display name, e.g. "Receipt (J24A)" or "Invoice INV-0042". */
  name: string;
  /** Filename to suggest on download, e.g. "INV-0042.pdf". */
  filename: string;
  /** Size in bytes. */
  size: number;
  createdAt: string;
}

export interface BoardEntry {
  id: string;
  /** Short 4-char job id from the originating Job (kept for back-compat). */
  jobId: string;
  /**
   * Human-friendly sequential number (1051, 1052…). Shown everywhere the
   * card is referenced — drawer header, board chip, receipts, emails.
   * Older entries created before this field existed have `undefined` and
   * the UI falls back to the opaque jobId for those.
   */
  displayNumber?: number;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  contactId: string | null;
  deviceModel: string;
  /** Emoji inferred from the device model text, or supplied explicitly. */
  deviceEmoji: string;
  /** Where the device is — taking (customer has it), leaving (with us), na. */
  deviceIntent: BoardDeviceIntent | null;
  flow: BoardFlow;
  status: BoardStatus;
  jobDescription: string;
  invoiceNumbers: string[];
  amountDueToday: number;
  amountPaid: number;
  paymentMethod: 'cash' | 'card' | 'pay_later' | null;
  /**
   * Reference to an encrypted password record in passwords.ts. When non-null,
   * the card's drawer shows a "Reveal password" button that calls the reveal
   * endpoint (audited). The record itself auto-expires after 30 days at which
   * point the reveal button reports "Expired".
   */
  passwordRecordId: string | null;
  /** Parts on order for this job. Rendered as a list above the comments. */
  parts: BoardPart[];
  /** PDFs saved to the card at checkout (receipt + Xero invoices). */
  attachments: BoardAttachment[];
  comments: BoardComment[];
  createdAt: string;
  createdBy: { name: string; email: string };
  updatedAt: string;
  /** Order within a column — higher = appears first. Set to Date.now() at create. */
  sortKey: number;
  /**
   * Marks the job as urgent. Shown on the board card as a yellow "RUSH" ribbon
   * so it stands out at a glance. Toggled from the drawer. Optional so older
   * entries load without it.
   */
  rush?: boolean;
}

/** Extract a display-friendly hostname from a URL. Returns '' if url is bad. */
export function extractDomain(url: string): string {
  try {
    const u = new URL(url);
    // Strip a leading "www." — "ebay.com.au" reads better than "www.ebay.com.au".
    return u.hostname.replace(/^www\./i, '');
  } catch {
    return '';
  }
}

// ── Emoji inference ──────────────────────────────────────────────────────

/** Best-effort guess of a device-type emoji from free-text model string. */
export function inferDeviceEmoji(model: string): string {
  const m = (model || '').toLowerCase();
  if (!m) return '💻';
  if (/\b(macbook|laptop|envy|thinkpad|ideapad|pavilion|latitude|inspiron|elitebook|zenbook|aspire|spectre|rog|probook|xps|nitro|predator|omen|vivobook|gram|swift|yoga|chromebook|surface laptop)\b/.test(m)) return '💻';
  if (/\b(imac|desktop|tower|workstation|all-in-one|aio)\b/.test(m)) return '🖥️';
  if (/\b(iphone|pixel|galaxy s|galaxy note|oneplus|phone|xperia|nokia)\b/.test(m)) return '📱';
  if (/\b(ipad|tablet|surface pro|galaxy tab)\b/.test(m)) return '📲';
  if (/\b(watch|wearable)\b/.test(m)) return '⌚';
  if (/\b(printer|mfp|scanner)\b/.test(m)) return '🖨️';
  if (/\b(server|nas)\b/.test(m)) return '🗄️';
  if (/\b(router|modem|switch|ap)\b/.test(m)) return '📡';
  return '💻';
}

// ── File IO ──────────────────────────────────────────────────────────────

async function ensureDir(): Promise<void> {
  if (!existsSync(DATA_DIR)) await mkdir(DATA_DIR, { recursive: true });
}

async function readJson<T>(path: string, fallback: T): Promise<T> {
  if (!existsSync(path)) return fallback;
  try {
    const raw = await readFile(path, 'utf8');
    return JSON.parse(raw) as T;
  } catch (err) {
    console.error(`[job-board] Failed to parse ${path}, starting empty:`, err);
    return fallback;
  }
}

async function writeJsonAtomic<T>(path: string, data: T): Promise<void> {
  await ensureDir();
  const tmp = path + '.tmp';
  await writeFile(tmp, JSON.stringify(data, null, 2));
  await rename(tmp, path);
}

// Per-file write queue so concurrent saves don't clobber each other.
const writeQueues = new Map<string, Promise<void>>();
function queueWrite(path: string, fn: () => Promise<void>): Promise<void> {
  const prev = writeQueues.get(path) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  writeQueues.set(path, next);
  return next;
}

// ── In-memory cache + pub/sub ────────────────────────────────────────────

let cache: BoardEntry[] | null = null;
let loadPromise: Promise<void> | null = null;

async function ensureLoaded(): Promise<void> {
  if (cache) return;
  if (!loadPromise) {
    loadPromise = readJson<BoardEntry[]>(BOARD_FILE, []).then((entries) => {
      const arr = Array.isArray(entries) ? entries : [];
      // Back-compat: hydrate fields added after the initial schema so existing
      // entries don't crash downstream consumers.
      for (const e of arr) {
        if (!Array.isArray(e.parts)) e.parts = [];
        if (!Array.isArray(e.comments)) e.comments = [];
        if (!Array.isArray(e.attachments)) e.attachments = [];
        if (e.passwordRecordId === undefined) e.passwordRecordId = null;
        if (e.deviceIntent === undefined) e.deviceIntent = null;
      }
      cache = arr;
    });
  }
  await loadPromise;
}

type Listener = (entries: BoardEntry[]) => void;
const listeners = new Set<Listener>();

export function onBoardChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function emit() {
  if (!cache) return;
  const snapshot = cache.slice();
  for (const l of listeners) l(snapshot);
}

async function persist(): Promise<void> {
  if (!cache) return;
  const snapshot = cache.slice();
  await queueWrite(BOARD_FILE, () => writeJsonAtomic(BOARD_FILE, snapshot));
}

// ── Public API ───────────────────────────────────────────────────────────

/** Returns a snapshot array of all entries. */
export async function getAllEntries(): Promise<BoardEntry[]> {
  await ensureLoaded();
  return cache!.slice();
}

/** Synchronous accessor for listeners that already hold the lock. */
export function getAllEntriesSync(): BoardEntry[] {
  return cache ? cache.slice() : [];
}

export interface CreateEntryInput {
  jobId: string;
  displayNumber?: number;
  customerName: string;
  customerEmail: string;
  customerPhone: string;
  contactId: string | null;
  deviceModel: string;
  deviceIntent?: BoardDeviceIntent | null;
  flow: BoardFlow;
  /** Starting column. Defaults match the flow (repair → booked_in, etc.). */
  status?: BoardStatus;
  jobDescription: string;
  invoiceNumbers: string[];
  amountDueToday: number;
  amountPaid: number;
  paymentMethod: 'cash' | 'card' | 'pay_later' | null;
  passwordRecordId?: string | null;
  createdBy: { name: string; email: string };
}

function defaultStatusForFlow(flow: BoardFlow): BoardStatus {
  switch (flow) {
    case 'repair':      return 'booked_in';
    case 'product':     return 'done_collected';
    case 'on_the_spot': return 'on_the_spot';
    case 'pickup':      return 'done_collected';
  }
}

export async function createEntry(input: CreateEntryInput): Promise<BoardEntry> {
  await ensureLoaded();
  const now = new Date().toISOString();
  const entry: BoardEntry = {
    id: randomUUID(),
    jobId: input.jobId,
    displayNumber: input.displayNumber,
    customerName: input.customerName,
    customerEmail: input.customerEmail,
    customerPhone: input.customerPhone,
    contactId: input.contactId,
    deviceModel: input.deviceModel,
    deviceEmoji: inferDeviceEmoji(input.deviceModel),
    deviceIntent: input.deviceIntent ?? null,
    flow: input.flow,
    status: input.status ?? defaultStatusForFlow(input.flow),
    jobDescription: input.jobDescription,
    invoiceNumbers: input.invoiceNumbers,
    amountDueToday: input.amountDueToday,
    amountPaid: input.amountPaid,
    paymentMethod: input.paymentMethod,
    passwordRecordId: input.passwordRecordId ?? null,
    parts: [],
    attachments: [],
    comments: [],
    createdAt: now,
    createdBy: input.createdBy,
    updatedAt: now,
    sortKey: Date.now(),
  };
  cache!.unshift(entry);
  await persist();
  emit();
  return entry;
}

/**
 * Pickup-flow handler: find the most recent open entry for this contact and
 * mark it done_collected. If none is found (e.g. the original intake happened
 * before the board existed), create a fresh entry in done_collected.
 */
export async function completeEntryForPickup(
  contactId: string | null,
  input: CreateEntryInput,
): Promise<BoardEntry> {
  await ensureLoaded();
  if (contactId) {
    const match = cache!
      .filter(e => e.contactId === contactId && e.status !== 'done_collected')
      .sort((a, b) => b.sortKey - a.sortKey)[0];
    if (match) {
      match.status = 'done_collected';
      match.updatedAt = new Date().toISOString();
      // Fold in the pickup's invoice numbers so both original + pickup
      // receipts are visible on the card.
      for (const inv of input.invoiceNumbers) {
        if (!match.invoiceNumbers.includes(inv)) match.invoiceNumbers.push(inv);
      }
      match.amountPaid += input.amountPaid;
      // Back-fill the display number on legacy cards if we now have one.
      if (match.displayNumber == null && input.displayNumber != null) {
        match.displayNumber = input.displayNumber;
      }
      await persist();
      emit();
      return match;
    }
  }
  return createEntry({ ...input, status: 'done_collected' });
}

export async function moveEntry(entryId: string, status: BoardStatus): Promise<BoardEntry | null> {
  await ensureLoaded();
  const e = cache!.find(x => x.id === entryId);
  if (!e) return null;
  if (e.status === status) return e;
  e.status = status;
  e.updatedAt = new Date().toISOString();
  // Bump sortKey so a just-moved card appears at the top of the new column.
  e.sortKey = Date.now();
  await persist();
  emit();
  return e;
}

export async function addComment(
  entryId: string,
  author: { name: string; email: string },
  body: string,
): Promise<BoardEntry | null> {
  await ensureLoaded();
  const trimmed = body.trim();
  if (!trimmed) return null;
  const e = cache!.find(x => x.id === entryId);
  if (!e) return null;
  const comment: BoardComment = {
    id: randomUUID(),
    author,
    body: trimmed,
    createdAt: new Date().toISOString(),
  };
  e.comments.push(comment);
  e.updatedAt = comment.createdAt;
  await persist();
  emit();
  return e;
}

export async function editComment(
  entryId: string,
  commentId: string,
  body: string,
): Promise<BoardEntry | null> {
  await ensureLoaded();
  const trimmed = body.trim();
  if (!trimmed) return null;
  const e = cache!.find(x => x.id === entryId);
  if (!e) return null;
  const c = e.comments.find(x => x.id === commentId);
  if (!c) return null;
  c.body = trimmed;
  c.editedAt = new Date().toISOString();
  e.updatedAt = c.editedAt;
  await persist();
  emit();
  return e;
}

export async function deleteComment(
  entryId: string,
  commentId: string,
): Promise<BoardEntry | null> {
  await ensureLoaded();
  const e = cache!.find(x => x.id === entryId);
  if (!e) return null;
  const i = e.comments.findIndex(x => x.id === commentId);
  if (i < 0) return null;
  e.comments.splice(i, 1);
  e.updatedAt = new Date().toISOString();
  await persist();
  emit();
  return e;
}

/**
 * Mutate a narrow set of entry fields from the drawer's edit UI. Only fields
 * that are safe to edit after creation are allowed here — status has its own
 * moveEntry path, and financial fields shouldn't be changed retroactively.
 */
export type EditableEntryField =
  | 'customerName'
  | 'customerEmail'
  | 'customerPhone'
  | 'deviceModel'
  | 'jobDescription'
  | 'deviceIntent'
  | 'rush';

export async function updateEntry(
  entryId: string,
  field: EditableEntryField,
  value: unknown,
): Promise<BoardEntry | null> {
  await ensureLoaded();
  const e = cache!.find(x => x.id === entryId);
  if (!e) return null;
  switch (field) {
    case 'customerName':
    case 'customerEmail':
    case 'customerPhone':
    case 'jobDescription':
      e[field] = String(value ?? '');
      break;
    case 'deviceModel': {
      const next = String(value ?? '');
      e.deviceModel = next;
      // Keep the emoji in sync with whatever model they've typed.
      e.deviceEmoji = inferDeviceEmoji(next);
      break;
    }
    case 'deviceIntent':
      if (value === null) e.deviceIntent = null;
      else if (isBoardDeviceIntent(value)) e.deviceIntent = value;
      else return e;  // ignore invalid intents rather than clearing
      break;
    case 'rush':
      e.rush = !!value;
      break;
  }
  e.updatedAt = new Date().toISOString();
  await persist();
  emit();
  return e;
}

export async function addPart(
  entryId: string,
  addedBy: { name: string; email: string },
  name: string,
  url: string,
): Promise<BoardEntry | null> {
  await ensureLoaded();
  const trimmedName = name.trim();
  const trimmedUrl = url.trim();
  if (!trimmedName || !trimmedUrl) return null;
  const e = cache!.find(x => x.id === entryId);
  if (!e) return null;
  const part: BoardPart = {
    id: randomUUID(),
    name: trimmedName,
    url: trimmedUrl,
    domain: extractDomain(trimmedUrl),
    addedBy,
    createdAt: new Date().toISOString(),
  };
  if (!Array.isArray(e.parts)) e.parts = [];
  e.parts.push(part);
  e.updatedAt = part.createdAt;
  await persist();
  emit();
  return e;
}

/**
 * Mark a part as arrived. Unlike `removePart`, this keeps the row on the
 * card so the UI can show an "Arrived" badge — received parts stay
 * visible instead of silently disappearing from the list.
 */
export async function markPartArrived(
  entryId: string,
  partId: string,
  arrivedBy: { name: string; email: string },
): Promise<BoardEntry | null> {
  await ensureLoaded();
  const e = cache!.find(x => x.id === entryId);
  if (!e || !Array.isArray(e.parts)) return null;
  const part = e.parts.find(p => p.id === partId);
  if (!part) return null;
  if (part.status === 'arrived') return e;
  part.status = 'arrived';
  part.arrivedAt = new Date().toISOString();
  part.arrivedBy = arrivedBy;
  e.updatedAt = part.arrivedAt;
  await persist();
  emit();
  return e;
}

export async function removePart(entryId: string, partId: string): Promise<BoardEntry | null> {
  await ensureLoaded();
  const e = cache!.find(x => x.id === entryId);
  if (!e || !Array.isArray(e.parts)) return null;
  const i = e.parts.findIndex(p => p.id === partId);
  if (i < 0) return null;
  e.parts.splice(i, 1);
  e.updatedAt = new Date().toISOString();
  await persist();
  emit();
  return e;
}

export async function deleteEntry(entryId: string): Promise<boolean> {
  await ensureLoaded();
  const i = cache!.findIndex(x => x.id === entryId);
  if (i < 0) return false;
  cache!.splice(i, 1);
  await persist();
  // Purge on-disk attachments so we don't leak files. Missing dir is fine.
  try { await rm(attachmentDir(entryId), { recursive: true, force: true }); } catch {}
  emit();
  return true;
}

// ── Attachments ──────────────────────────────────────────────────────────
//
// PDFs are stored by (entryId, attachmentId) on disk. The metadata record
// lives on the BoardEntry so listeners see it in the broadcast snapshot;
// the bytes are streamed via a dedicated route.

function attachmentDir(entryId: string): string {
  return join(ATTACHMENTS_DIR, entryId);
}

function attachmentPath(entryId: string, attachmentId: string): string {
  return join(attachmentDir(entryId), `${attachmentId}.pdf`);
}

export interface AddAttachmentInput {
  kind: BoardAttachmentKind;
  name: string;
  filename: string;
  data: Buffer;
}

export async function addAttachment(
  entryId: string,
  input: AddAttachmentInput,
): Promise<BoardAttachment | null> {
  await ensureLoaded();
  const e = cache!.find(x => x.id === entryId);
  if (!e) return null;
  const id = randomUUID();
  const dir = attachmentDir(entryId);
  if (!existsSync(dir)) await mkdir(dir, { recursive: true });
  const filePath = attachmentPath(entryId, id);
  // Atomic write via .tmp rename so partial writes don't end up in the list.
  const tmp = filePath + '.tmp';
  await writeFile(tmp, input.data);
  await rename(tmp, filePath);
  const attachment: BoardAttachment = {
    id,
    kind: input.kind,
    name: input.name,
    filename: input.filename,
    size: input.data.length,
    createdAt: new Date().toISOString(),
  };
  if (!Array.isArray(e.attachments)) e.attachments = [];
  e.attachments.push(attachment);
  e.updatedAt = attachment.createdAt;
  await persist();
  emit();
  return attachment;
}

/**
 * Read raw PDF bytes for an attachment. Returns null when the entry or file
 * is missing (either purged, or a stale id from the client).
 */
export async function readAttachmentBytes(
  entryId: string,
  attachmentId: string,
): Promise<{ bytes: Buffer; meta: BoardAttachment } | null> {
  await ensureLoaded();
  const e = cache!.find(x => x.id === entryId);
  if (!e) return null;
  const meta = (e.attachments || []).find(a => a.id === attachmentId);
  if (!meta) return null;
  const fp = attachmentPath(entryId, attachmentId);
  if (!existsSync(fp)) return null;
  const bytes = await readFile(fp);
  return { bytes, meta };
}

/** Cold-path init so the cache is primed at server boot. */
export async function initJobBoard(): Promise<void> {
  await ensureLoaded();
}

// ── Customer search ──────────────────────────────────────────────────────

export interface CustomerSuggestion {
  name: string;
  email: string;
  phone: string;
  /** Xero contactId from the most recent matching entry, if any. */
  contactId: string | null;
  /** Most recent time we saw this customer on the board. */
  lastSeen: string;
  /** How many entries this customer has on the board. */
  jobCount: number;
}

function normPhone(s: string): string {
  return (s || '').replace(/\D+/g, '');
}

/**
 * Returns up to `limit` unique customers whose name/phone/email matches `query`.
 * Deduped by (lowercase email | normalized phone | lowercase name) so the same
 * person doesn't appear once per job. Ordered by most recent activity.
 */
export function searchCustomers(query: string, limit = 8): CustomerSuggestion[] {
  const q = (query || '').trim().toLowerCase();
  if (!q || !cache) return [];
  const qDigits = normPhone(q);
  const seen = new Map<string, CustomerSuggestion>();
  // Newest first so later (older) duplicates don't overwrite the latest contactId.
  const sorted = cache.slice().sort((a, b) => {
    const ta = Date.parse(a.updatedAt || a.createdAt || '') || 0;
    const tb = Date.parse(b.updatedAt || b.createdAt || '') || 0;
    return tb - ta;
  });
  for (const e of sorted) {
    const name = (e.customerName || '').toLowerCase();
    const email = (e.customerEmail || '').toLowerCase();
    const phoneDigits = normPhone(e.customerPhone);
    const nameHit = name.includes(q);
    const emailHit = email.includes(q);
    const phoneHit = qDigits.length >= 3 && phoneDigits.includes(qDigits);
    const jobHit = String(e.jobId || '').toLowerCase().includes(q.replace(/^#/, ''));
    if (!nameHit && !emailHit && !phoneHit && !jobHit) continue;
    const key = email || phoneDigits || name;
    if (!key) continue;
    const existing = seen.get(key);
    if (existing) {
      existing.jobCount += 1;
      continue;
    }
    seen.set(key, {
      name: e.customerName,
      email: e.customerEmail,
      phone: e.customerPhone,
      contactId: e.contactId,
      lastSeen: e.updatedAt || e.createdAt,
      jobCount: 1,
    });
    if (seen.size >= limit) break;
  }
  return Array.from(seen.values());
}

/**
 * Active (not-yet-collected) board entries for a given customer. Used by
 * the pickup flow to show "all of this customer's jobs, grouped" instead
 * of a flat list of Xero invoices.
 *
 * Match order (first hit wins per entry):
 *   1. contactId exact match (most reliable — set in step 1 via Xero lookup)
 *   2. normalized phone (digits only, min 6 digits to avoid false positives)
 *   3. lowercased email exact match
 *
 * "Active" = any BoardStatus except `done_collected`. Newest-updated first.
 */
export function getActiveEntriesForContact(
  lookup: { contactId?: string | null; phone?: string | null; email?: string | null },
): BoardEntry[] {
  if (!cache) return [];
  const targetContactId = (lookup.contactId || '').trim() || null;
  const targetPhone = normPhone(lookup.phone || '');
  const targetEmail = (lookup.email || '').trim().toLowerCase();
  // Require at least one usable key — otherwise we'd match everyone.
  if (!targetContactId && targetPhone.length < 6 && !targetEmail) return [];

  const matches = cache.filter(e => {
    if (e.status === 'done_collected') return false;
    if (targetContactId && e.contactId && e.contactId === targetContactId) return true;
    if (targetPhone.length >= 6 && normPhone(e.customerPhone) === targetPhone) return true;
    if (targetEmail && (e.customerEmail || '').trim().toLowerCase() === targetEmail) return true;
    return false;
  });

  return matches.sort((a, b) => {
    const ta = Date.parse(a.updatedAt || a.createdAt || '') || 0;
    const tb = Date.parse(b.updatedAt || b.createdAt || '') || 0;
    return tb - ta;
  });
}
