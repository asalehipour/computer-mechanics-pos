import { withAudit } from './audit.js';
import type { PingResult } from './types.js';

export interface TyroChargeResult {
  approved: boolean;
  transactionRef: string;
  amount: number;
  cardType?: string;
  cardLastFour?: string;
  declineReason?: string;
}

export interface TyroPairingStatus {
  paired: boolean;
  terminalId?: string;
  message: string;
}

export interface TyroClient {
  ping(): Promise<PingResult>;
  getPairingStatus(): Promise<TyroPairingStatus>;
  /** Charge an amount in AUD. Stub resolves after 500ms as approved. */
  charge(input: { amount: number; reference: string }): Promise<TyroChargeResult>;
}

// ── Stub ────────────────────────────────────────────────────────────────────
function rid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

const CARD_TYPES = ['VISA', 'MASTERCARD', 'EFTPOS'] as const;
function randomCard(): { type: string; last4: string } {
  const type = CARD_TYPES[Math.floor(Math.random() * CARD_TYPES.length)];
  const last4 = String(Math.floor(1000 + Math.random() * 9000));
  return { type, last4 };
}

export const tyroStub: TyroClient = {
  ping: withAudit('tyro', 'ping', 'stub', async () => ({
    result: { ok: true, mode: 'stub', message: 'Tyro stub responding (no terminal paired)' } as PingResult,
    summary: 'stub alive',
  })),

  getPairingStatus: withAudit('tyro', 'getPairingStatus', 'stub', async () => ({
    result: { paired: false, message: 'Stub mode — no real terminal' } as TyroPairingStatus,
    summary: 'unpaired stub',
  })),

  charge: withAudit('tyro', 'charge', 'stub', async ({ amount, reference }) => {
    await new Promise(r => setTimeout(r, 500));
    const card = randomCard();
    const result: TyroChargeResult = {
      approved: true,
      transactionRef: rid('stubtx'),
      amount,
      cardType: card.type,
      cardLastFour: card.last4,
    };
    return { result, summary: `APPROVED $${amount.toFixed(2)} ${card.type} •••• ${card.last4} (ref ${reference})` };
  }),
};

// ── Factory ─────────────────────────────────────────────────────────────────
export function getTyroClient(): TyroClient {
  return tyroStub;
}
