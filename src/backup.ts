/**
 * Backup & restore of the entire `data/` directory.
 *
 * The backup bundles everything that defines "the shop's state": job board,
 * attachments (receipt/invoice PDFs), encrypted password records, settings,
 * and the encryption key itself. Restoring from a backup on a fresh Railway
 * volume should reproduce the live site byte-for-byte.
 *
 * Format: a plain zip so it's openable with any unzip tool. We use adm-zip
 * which is sync; our data dir is small (tens of MB at most) so the blocking
 * cost is negligible and the code is simpler than streaming.
 *
 * Safety note: the backup includes `encryption.key`, which can decrypt
 * customer passwords. Treat backup zips as sensitive — they're equivalent to
 * the live server from an attacker's point of view.
 */

import AdmZip from 'adm-zip';
import { readdir, stat, readFile, writeFile, mkdir, rm, rename } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, relative, sep } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const DATA_DIR = join(__dirname, '..', 'data');

/**
 * Files we refuse to include or overwrite. `*.tmp` are atomic-write
 * scratch files that may exist mid-save and shouldn't round-trip.
 */
const EXCLUDE_PATTERNS: RegExp[] = [
  /\.tmp$/i,
  /\.DS_Store$/i,
];

function shouldExclude(relPath: string): boolean {
  return EXCLUDE_PATTERNS.some(r => r.test(relPath));
}

/** Recursively collect all files under `dir`, returning relative paths. */
async function walk(dir: string, baseDir: string): Promise<string[]> {
  if (!existsSync(dir)) return [];
  const out: string[] = [];
  const entries = await readdir(dir, { withFileTypes: true });
  for (const e of entries) {
    const full = join(dir, e.name);
    const rel = relative(baseDir, full);
    if (shouldExclude(rel)) continue;
    if (e.isDirectory()) {
      out.push(...(await walk(full, baseDir)));
    } else if (e.isFile()) {
      out.push(rel);
    }
  }
  return out;
}

/**
 * Build a zip of the entire data/ directory and return its bytes.
 * Intended to be streamed straight into an HTTP response.
 */
export async function createBackupBuffer(): Promise<Buffer> {
  const zip = new AdmZip();
  const files = await walk(DATA_DIR, DATA_DIR);
  for (const rel of files) {
    const full = join(DATA_DIR, rel);
    const bytes = await readFile(full);
    // Normalise separators so Windows-created zips also open cleanly.
    const entryName = rel.split(sep).join('/');
    zip.addFile(entryName, bytes);
  }
  // Tag the bundle so restore can sanity-check it's one of ours.
  const manifest = {
    version: 1,
    createdAt: new Date().toISOString(),
    fileCount: files.length,
    format: 'computer-mechanics-pos-backup',
  };
  zip.addFile('MANIFEST.json', Buffer.from(JSON.stringify(manifest, null, 2), 'utf8'));
  return zip.toBuffer();
}

/**
 * Validate and unpack a backup zip into `data/`, replacing current contents
 * atomically. The existing data/ is moved aside first so a failed extract
 * doesn't leave the server half-restored.
 */
export async function restoreFromBuffer(buf: Buffer): Promise<{ fileCount: number }> {
  if (!buf || buf.length < 10) throw new Error('Backup zip is empty or too small.');
  let zip: AdmZip;
  try {
    zip = new AdmZip(buf);
  } catch (err) {
    throw new Error('Not a valid zip file: ' + (err instanceof Error ? err.message : String(err)));
  }

  const entries = zip.getEntries();
  const manifestEntry = entries.find(e => e.entryName === 'MANIFEST.json');
  if (!manifestEntry) {
    throw new Error('Backup missing MANIFEST.json — not a Computer Mechanics POS backup.');
  }
  let manifest: { format?: string; version?: number };
  try {
    manifest = JSON.parse(manifestEntry.getData().toString('utf8'));
  } catch {
    throw new Error('MANIFEST.json is corrupt.');
  }
  if (manifest.format !== 'computer-mechanics-pos-backup') {
    throw new Error('Backup manifest format mismatch — refusing to restore.');
  }

  // Guard against zip-slip: reject any entry path that escapes DATA_DIR.
  const safeEntries = entries
    .filter(e => e.entryName !== 'MANIFEST.json')
    .filter(e => !e.isDirectory);
  for (const e of safeEntries) {
    const name = e.entryName;
    if (name.includes('..') || name.startsWith('/') || /^[a-zA-Z]:/.test(name)) {
      throw new Error(`Backup contains unsafe entry path: ${name}`);
    }
  }

  // Move current data/ aside so we can roll back on failure.
  const parent = dirname(DATA_DIR);
  const backupAside = join(parent, `data.pre-restore.${Date.now()}`);
  if (existsSync(DATA_DIR)) {
    await rename(DATA_DIR, backupAside);
  }
  await mkdir(DATA_DIR, { recursive: true });

  try {
    for (const e of safeEntries) {
      const outPath = join(DATA_DIR, e.entryName.split('/').join(sep));
      await mkdir(dirname(outPath), { recursive: true });
      await writeFile(outPath, e.getData());
    }
    // Success — remove the old dir we moved aside.
    if (existsSync(backupAside)) await rm(backupAside, { recursive: true, force: true });
    return { fileCount: safeEntries.length };
  } catch (err) {
    // Roll back: restore the old dir.
    try {
      await rm(DATA_DIR, { recursive: true, force: true });
      if (existsSync(backupAside)) await rename(backupAside, DATA_DIR);
    } catch (rollbackErr) {
      console.error('[backup] Rollback failed — data/ may be in a mixed state:', rollbackErr);
    }
    throw err;
  }
}

/** Quick stats for UI: how big is the data/ dir, how many files. */
export async function backupSummary(): Promise<{ fileCount: number; totalBytes: number }> {
  const files = await walk(DATA_DIR, DATA_DIR);
  let total = 0;
  for (const rel of files) {
    const s = await stat(join(DATA_DIR, rel));
    total += s.size;
  }
  return { fileCount: files.length, totalBytes: total };
}
