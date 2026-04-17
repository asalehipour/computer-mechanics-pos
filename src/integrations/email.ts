import { withAudit } from './audit.js';
import type { PingResult } from './types.js';

export interface EmailAttachment {
  filename: string;
  data: Buffer | Uint8Array;
  contentType?: string;
}

export interface EmailSendInput {
  to: string;
  subject: string;
  bodyHtml: string;
  attachments?: EmailAttachment[];
}

export interface EmailClient {
  ping(): Promise<PingResult>;
  send(input: EmailSendInput): Promise<{ messageId: string }>;
  /** Schedule an email to send after delayMs. Stub only — not persisted across restarts. */
  sendDelayed(input: EmailSendInput & { delayMs: number }): Promise<{ scheduledId: string; sendAt: string }>;
}

// ── Stub ────────────────────────────────────────────────────────────────────
function rid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

export const emailStub: EmailClient = {
  ping: withAudit('email', 'ping', 'stub', async () => ({
    result: { ok: true, mode: 'stub', message: 'Email stub responding (no SMTP configured)' } as PingResult,
    summary: 'stub alive',
  })),

  send: withAudit('email', 'send', 'stub', async ({ to, subject, attachments }) => {
    const attachSummary = attachments?.length ? ` +${attachments.length} attachment(s)` : '';
    return {
      result: { messageId: rid('stubmsg') },
      summary: `to=${to} subj="${subject.slice(0, 40)}"${attachSummary}`,
    };
  }),

  sendDelayed: withAudit('email', 'sendDelayed', 'stub', async ({ to, subject, delayMs }) => {
    const sendAt = new Date(Date.now() + delayMs).toISOString();
    const scheduledId = rid('stubsched');
    // In-memory only. Real client will persist to a job table.
    setTimeout(() => {
      void emailStub.send({ to, subject, bodyHtml: '<!-- deferred stub send -->' });
    }, delayMs);
    return { result: { scheduledId, sendAt }, summary: `to=${to} at ${sendAt}` };
  }),
};

// ── Factory ─────────────────────────────────────────────────────────────────
export function getEmailClient(): EmailClient {
  return emailStub;
}
