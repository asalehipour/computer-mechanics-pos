import { withAudit } from './audit.js';
import type { Contact, Invoice, LineItem, Payment, PingResult } from './types.js';

export interface XeroClient {
  ping(): Promise<PingResult>;
  findContactByEmail(email: string): Promise<Contact | null>;
  findContactByName(firstName: string, lastName: string): Promise<Contact | null>;
  createContact(data: Omit<Contact, 'contactId'>): Promise<Contact>;
  createInvoice(data: {
    contactId: string;
    lineItems: LineItem[];
    reference?: string;
  }): Promise<Invoice>;
  createPayment(data: {
    invoiceId: string;
    amount: number;
    reference?: string;
  }): Promise<Payment>;
  listOpenInvoicesByContact(contactId: string): Promise<Invoice[]>;
  /** Returns the invoice as a PDF buffer. Real Xero provides this via GET /Invoices/{id}/Online. */
  getInvoicePdf(invoiceId: string): Promise<Buffer>;
}

// ── In-memory state for the stub ────────────────────────────────────────────
const stubContacts = new Map<string, Contact>();
const stubInvoices = new Map<string, Invoice>();
const stubPayments = new Map<string, Payment>();
let invoiceCounter = 1000;

function rid(prefix: string): string {
  return `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
}

function sumTotal(lines: LineItem[]): number {
  return Math.round(lines.reduce((s, l) => s + l.quantity * l.unitPriceIncGst, 0) * 100) / 100;
}

// ── Stub implementation ─────────────────────────────────────────────────────
export const xeroStub: XeroClient = {
  ping: withAudit('xero', 'ping', 'stub', async () => ({
    result: { ok: true, mode: 'stub', message: 'Xero stub responding' } as PingResult,
    summary: 'stub alive',
  })),

  findContactByEmail: withAudit('xero', 'findContactByEmail', 'stub', async (email: string) => {
    const needle = email.toLowerCase();
    const match = [...stubContacts.values()].find(c => c.email?.toLowerCase() === needle) ?? null;
    return { result: match, summary: match ? `hit: ${match.firstName} ${match.lastName}` : 'no match' };
  }),

  findContactByName: withAudit('xero', 'findContactByName', 'stub', async (first: string, last: string) => {
    const match = [...stubContacts.values()].find(
      c => c.firstName.toLowerCase() === first.toLowerCase() && c.lastName.toLowerCase() === last.toLowerCase(),
    ) ?? null;
    return { result: match, summary: match ? `hit: ${first} ${last}` : 'no match' };
  }),

  createContact: withAudit('xero', 'createContact', 'stub', async (data) => {
    const contact: Contact = { contactId: rid('stubcontact'), ...data };
    stubContacts.set(contact.contactId, contact);
    return { result: contact, summary: `created ${contact.firstName} ${contact.lastName}` };
  }),

  createInvoice: withAudit('xero', 'createInvoice', 'stub', async (data) => {
    const total = sumTotal(data.lineItems);
    const invoice: Invoice = {
      invoiceId: rid('stubinv'),
      invoiceNumber: `INV-${++invoiceCounter}`,
      contactId: data.contactId,
      status: 'AUTHORISED',
      lineItems: data.lineItems,
      totalIncGst: total,
      amountPaid: 0,
      amountDue: total,
      reference: data.reference,
      createdAt: new Date().toISOString(),
    };
    stubInvoices.set(invoice.invoiceId, invoice);
    return { result: invoice, summary: `${invoice.invoiceNumber} for $${total.toFixed(2)}` };
  }),

  createPayment: withAudit('xero', 'createPayment', 'stub', async (data) => {
    const invoice = stubInvoices.get(data.invoiceId);
    if (!invoice) throw new Error(`Invoice ${data.invoiceId} not found`);
    const payment: Payment = {
      paymentId: rid('stubpay'),
      invoiceId: data.invoiceId,
      amount: data.amount,
      paidAt: new Date().toISOString(),
      reference: data.reference,
    };
    stubPayments.set(payment.paymentId, payment);
    invoice.amountPaid = Math.round((invoice.amountPaid + data.amount) * 100) / 100;
    invoice.amountDue = Math.round((invoice.totalIncGst - invoice.amountPaid) * 100) / 100;
    if (invoice.amountDue <= 0.005) invoice.status = 'PAID';
    return { result: payment, summary: `$${data.amount.toFixed(2)} → ${invoice.invoiceNumber}` };
  }),

  listOpenInvoicesByContact: withAudit('xero', 'listOpenInvoicesByContact', 'stub', async (contactId: string) => {
    const invoices = [...stubInvoices.values()]
      .filter(i => i.contactId === contactId && i.status !== 'PAID' && i.status !== 'VOIDED')
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { result: invoices, summary: `${invoices.length} open` };
  }),

  getInvoicePdf: withAudit('xero', 'getInvoicePdf', 'stub', async (invoiceId: string) => {
    const invoice = stubInvoices.get(invoiceId);
    if (!invoice) throw new Error(`Invoice ${invoiceId} not found`);
    // Minimal valid PDF header so something sensible opens if a client tries.
    const body = `%PDF-1.4\n% Stub invoice PDF\n% ${invoice.invoiceNumber} — $${invoice.totalIncGst.toFixed(2)}\n%%EOF\n`;
    return { result: Buffer.from(body, 'utf8'), summary: `${invoice.invoiceNumber} (${body.length}b stub)` };
  }),
};

// ── Factory ─────────────────────────────────────────────────────────────────
// TODO: when xero.useLive flag is true AND credentials are configured, return
// a real client. Until then always stub.
export function getXeroClient(): XeroClient {
  return xeroStub;
}

export function resetXeroStubState(): void {
  stubContacts.clear();
  stubInvoices.clear();
  stubPayments.clear();
  invoiceCounter = 1000;
}

/**
 * Dev-only: seed a realistic "deposit paid, balance due" invoice against the
 * given contact so pickup can be tested end-to-end before the checkout flow is
 * wired up to create real invoices. Delete this when checkout creates invoices
 * for real.
 */
export function seedPickupTestInvoice(contactId: string): Invoice {
  const lines: LineItem[] = [
    { description: 'Screen replacement — 14" FHD', quantity: 1, unitPriceIncGst: 385 },
    { description: 'Diagnostic', quantity: 1, unitPriceIncGst: 85 },
  ];
  const total = sumTotal(lines);
  const deposit = Math.round(total * 0.5 * 100) / 100;
  const invoice: Invoice = {
    invoiceId: rid('stubinv'),
    invoiceNumber: `INV-${++invoiceCounter}`,
    contactId,
    status: 'AUTHORISED',
    lineItems: lines,
    totalIncGst: total,
    amountPaid: deposit,
    amountDue: Math.round((total - deposit) * 100) / 100,
    reference: 'Dropped off for repair',
    createdAt: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString(),
  };
  stubInvoices.set(invoice.invoiceId, invoice);
  return invoice;
}
