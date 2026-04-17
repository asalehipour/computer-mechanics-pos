/**
 * In-memory ring buffer of the last N integration calls. Visible in the
 * Settings → Diagnostics panel. Not persisted — resets on server restart.
 */

export type AuditService = 'xero' | 'tyro' | 'email';
export type AuditStatus = 'ok' | 'error';
export type AuditMode = 'stub' | 'live';

export interface AuditEntry {
  id: string;
  timestamp: string;
  service: AuditService;
  method: string;
  status: AuditStatus;
  durationMs: number;
  mode: AuditMode;
  summary?: string;
}

const MAX_ENTRIES = 50;
const buffer: AuditEntry[] = [];

export function recordAudit(entry: Omit<AuditEntry, 'id' | 'timestamp'>): void {
  buffer.unshift({
    id: crypto.randomUUID(),
    timestamp: new Date().toISOString(),
    ...entry,
  });
  if (buffer.length > MAX_ENTRIES) buffer.length = MAX_ENTRIES;
}

export function getAuditLog(): AuditEntry[] {
  return [...buffer];
}

export function clearAuditLog(): void {
  buffer.length = 0;
}

/**
 * Wraps a stub method so it auto-records to the audit log. Usage:
 *   findContactByEmail: withAudit('xero', 'findContactByEmail', async (email) => { ... })
 */
export function withAudit<Args extends unknown[], R>(
  service: AuditService,
  method: string,
  mode: AuditMode,
  fn: (...args: Args) => Promise<{ result: R; summary?: string }>,
): (...args: Args) => Promise<R> {
  return async (...args: Args) => {
    const start = Date.now();
    try {
      const { result, summary } = await fn(...args);
      recordAudit({ service, method, status: 'ok', durationMs: Date.now() - start, mode, summary });
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordAudit({ service, method, status: 'error', durationMs: Date.now() - start, mode, summary: message });
      throw err;
    }
  };
}
