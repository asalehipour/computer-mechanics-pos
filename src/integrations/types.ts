/**
 * Shared types for all integrations. Kept deliberately small — we add fields
 * as flows require them, not speculatively.
 */

export interface Contact {
  contactId: string;
  firstName: string;
  lastName: string;
  email?: string;
  phone?: string;
  postcode?: string;
  company?: string;
}

export interface LineItem {
  description: string;
  quantity: number;
  /** AUD, GST-inclusive, per unit */
  unitPriceIncGst: number;
  /** Xero account code (e.g. "200" for sales). Optional in stubs. */
  accountCode?: string;
}

export type InvoiceStatus = 'DRAFT' | 'AUTHORISED' | 'PAID' | 'VOIDED';

export interface Invoice {
  invoiceId: string;
  invoiceNumber: string;
  contactId: string;
  status: InvoiceStatus;
  lineItems: LineItem[];
  /** Sum of qty * unitPriceIncGst across all line items, in AUD */
  totalIncGst: number;
  amountPaid: number;
  amountDue: number;
  reference?: string;
  createdAt: string;
}

export interface Payment {
  paymentId: string;
  invoiceId: string;
  amount: number;
  paidAt: string;
  reference?: string;
}

export interface PingResult {
  ok: boolean;
  mode: 'stub' | 'live';
  message: string;
}
