/**
 * Server-side receipt PDF generation with pdfkit.
 *
 * Produces the same information the on-screen receipt shows — customer,
 * device, services/line items, totals, payment info — in a single-page A4
 * layout. Saved as an attachment on the BoardEntry at checkout so staff can
 * download/view it later from the job card.
 */

import PDFDocument from 'pdfkit';
import type { Job, PaymentMethod } from './job.js';

// ── Helpers ──────────────────────────────────────────────────────────────
const AUD = (n: number): string => `$${(Number(n) || 0).toFixed(2)}`;

function methodLabel(m: PaymentMethod | null | undefined): string {
  if (m === 'cash')      return 'Cash';
  if (m === 'card')      return 'Card (EFTPOS)';
  if (m === 'pay_later') return 'Pay later (invoiced)';
  return '—';
}

/**
 * Collects the {label, amount} rows to print on the receipt based on which
 * flow the job went through. Mirrors `lineItemsForFlow` in job.ts but keeps
 * the display labels stripped of Xero-specific detail.
 */
function flowLines(job: Job): { label: string; amount: number }[] {
  const rows: { label: string; amount: number }[] = [];
  if (job.repair) {
    for (const l of job.repair.lines) {
      const label = [l.service, l.variant].filter(Boolean).join(' — ');
      rows.push({ label: label || 'Repair service', amount: Number(l.cost) || 0 });
    }
    if (job.repair.customServiceName && Number(job.repair.customServiceAmount) > 0) {
      rows.push({ label: job.repair.customServiceName, amount: Number(job.repair.customServiceAmount) || 0 });
    }
  } else if (job.product) {
    for (const p of job.product.lines) {
      const qty = Number(p.qty) || 0;
      const unit = Number(p.unitPrice) || 0;
      rows.push({ label: `${p.name}${qty > 1 ? ` × ${qty}` : ''}`, amount: unit * qty });
    }
  } else if (job.onTheSpot) {
    const o = job.onTheSpot;
    const fixed = Number(o.price) || 0;
    const hours = Number(o.hours) || 0;
    const rate = Number(o.hourlyRate) || 0;
    if (fixed > 0)             rows.push({ label: o.description || 'Quick fix', amount: fixed });
    if (hours > 0 && rate > 0) rows.push({ label: `Labour (${hours}h × ${AUD(rate)}/h)`, amount: hours * rate });
  } else if (job.pickup) {
    const pu = job.pickup;
    const selected = pu.invoices.find(i => i.invoiceId === pu.selectedInvoiceId);
    if (selected) {
      rows.push({ label: `Invoice ${selected.invoiceNumber} — balance due`, amount: Number(selected.amountDue) || 0 });
    }
    for (const l of pu.extraLines) {
      rows.push({ label: l.description || 'Additional charge', amount: Number(l.amount) || 0 });
    }
  }
  return rows;
}

// ── Main generator ───────────────────────────────────────────────────────
export interface GenerateReceiptOptions {
  job: Job;
  /** Invoice numbers attached to this receipt — printed near the footer. */
  invoiceNumbers: string[];
  /** The method actually used at checkout (nullable since job.checkout may be cleared). */
  method: PaymentMethod;
  amountDueToday: number;
  amountPaid: number;
  cashTendered?: number;
  changeGiven?: number;
}

/**
 * Build the receipt PDF and resolve with the final bytes. pdfkit streams data
 * into chunks; we accumulate them, then hand back a single Buffer ready to
 * write to disk or email.
 */
export function generateReceiptPdf(opts: GenerateReceiptOptions): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 48 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    renderReceipt(doc, opts);
    doc.end();
  });
}

function renderReceipt(doc: PDFKit.PDFDocument, opts: GenerateReceiptOptions): void {
  const { job } = opts;
  const customerName = `${job.customer.firstName} ${job.customer.lastName}`.trim();
  const now = new Date();

  // ── Header ────────────────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(22).fillColor('#111').text('Computer Mechanics', { align: 'left' });
  doc.moveDown(0.15);
  doc.font('Helvetica').fontSize(10).fillColor('#555')
    .text('computer-mechanics.com.au · Melbourne, AU', { align: 'left' });

  // Right-aligned receipt metadata
  const topY = doc.y - 32;
  doc.font('Helvetica-Bold').fontSize(14).fillColor('#111')
    .text(opts.method === 'pay_later' ? 'TAX INVOICE' : 'RECEIPT', 380, topY, { width: 170, align: 'right' });
  doc.font('Helvetica').fontSize(10).fillColor('#555')
    .text(`Job #${job.id}`, 380, topY + 20, { width: 170, align: 'right' })
    .text(now.toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' }), 380, topY + 34, { width: 170, align: 'right' });

  doc.moveDown(2);
  doc.strokeColor('#e0e0e0').lineWidth(1)
    .moveTo(48, doc.y).lineTo(547, doc.y).stroke();
  doc.moveDown(0.8);

  // ── Customer block ────────────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(11).fillColor('#111').text('BILL TO');
  doc.moveDown(0.2);
  doc.font('Helvetica').fontSize(11).fillColor('#111').text(customerName || '—');
  if (job.customer.email) doc.fillColor('#555').text(job.customer.email);
  if (job.customer.phone) doc.fillColor('#555').text(job.customer.phone);
  if (job.customer.company) doc.fillColor('#555').text(job.customer.company);

  // Device block (only when repair/onTheSpot has one)
  const deviceModel = job.repair?.deviceModel || '';
  if (deviceModel) {
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111').text('DEVICE');
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(11).fillColor('#111').text(deviceModel);
  }

  const jobDesc = job.repair?.jobDescription || job.onTheSpot?.description || job.pickup?.extraNotes || '';
  if (jobDesc) {
    doc.moveDown(0.8);
    doc.font('Helvetica-Bold').fontSize(11).fillColor('#111').text('DESCRIPTION');
    doc.moveDown(0.2);
    doc.font('Helvetica').fontSize(10).fillColor('#333').text(jobDesc, { width: 500 });
  }

  doc.moveDown(1);

  // ── Line items table ──────────────────────────────────────────────────
  const rows = flowLines(job);
  const tableTop = doc.y;
  const colLabelX = 48;
  const colAmountX = 460;
  const tableWidth = 499;

  doc.font('Helvetica-Bold').fontSize(10).fillColor('#555');
  doc.text('ITEM', colLabelX, tableTop);
  doc.text('AMOUNT', colAmountX, tableTop, { width: 87, align: 'right' });
  doc.moveDown(0.4);
  doc.strokeColor('#ddd').moveTo(48, doc.y).lineTo(547, doc.y).stroke();
  doc.moveDown(0.3);

  doc.font('Helvetica').fontSize(11).fillColor('#111');
  let subtotal = 0;
  if (rows.length === 0) {
    doc.fillColor('#888').text('(No line items recorded)', colLabelX, doc.y);
    doc.moveDown(0.3);
  } else {
    for (const r of rows) {
      const y = doc.y;
      doc.fillColor('#111').text(r.label, colLabelX, y, { width: 380 });
      doc.text(AUD(r.amount), colAmountX, y, { width: 87, align: 'right' });
      subtotal += r.amount;
      doc.moveDown(0.4);
    }
  }

  // ── Totals ────────────────────────────────────────────────────────────
  doc.moveDown(0.3);
  doc.strokeColor('#ddd').moveTo(48, doc.y).lineTo(547, doc.y).stroke();
  doc.moveDown(0.5);

  const totalsRight = (label: string, amount: string, bold = false) => {
    const y = doc.y;
    doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(bold ? 12 : 10).fillColor('#111');
    doc.text(label, 320, y, { width: 140, align: 'right' });
    doc.text(amount, colAmountX, y, { width: 87, align: 'right' });
    doc.moveDown(0.4);
  };

  // GST = 1/11th of the incl. total (AU standard).
  const gstIncluded = subtotal > 0 ? subtotal / 11 : 0;
  totalsRight('Subtotal', AUD(subtotal));
  totalsRight('GST (included)', AUD(gstIncluded));
  totalsRight('Total', AUD(subtotal), true);

  if (opts.amountDueToday !== subtotal) {
    doc.moveDown(0.2);
    totalsRight('Amount due today', AUD(opts.amountDueToday), true);
  }

  // ── Payment info ──────────────────────────────────────────────────────
  doc.moveDown(0.8);
  doc.strokeColor('#ddd').moveTo(48, doc.y).lineTo(547, doc.y).stroke();
  doc.moveDown(0.6);

  doc.font('Helvetica-Bold').fontSize(11).fillColor('#111').text('PAYMENT', colLabelX);
  doc.moveDown(0.2);
  doc.font('Helvetica').fontSize(10).fillColor('#333');
  doc.text(`Method: ${methodLabel(opts.method)}`);
  if (opts.method === 'cash' && typeof opts.cashTendered === 'number') {
    doc.text(`Cash tendered: ${AUD(opts.cashTendered)}`);
    doc.text(`Change given: ${AUD(opts.changeGiven ?? 0)}`);
  }
  doc.text(`Paid today: ${AUD(opts.amountPaid)}`);
  if (opts.method === 'pay_later') {
    doc.moveDown(0.3);
    doc.fillColor('#8c1f1f').text('PAY LATER — please settle the attached invoice.');
  }

  if (opts.invoiceNumbers.length > 0) {
    doc.moveDown(0.4);
    doc.fillColor('#555').text(`Xero invoice(s): ${opts.invoiceNumbers.join(', ')}`);
  }

  // ── Footer ────────────────────────────────────────────────────────────
  doc.moveDown(1.5);
  doc.font('Helvetica').fontSize(9).fillColor('#888')
    .text(`Served by: ${job.startedBy.name}  ·  ABN 00 000 000 000  ·  Prices inc. GST`,
      48, 780, { width: 499, align: 'center' });
}
