/**
 * Server-side receipt PDF generation with pdfkit.
 *
 * Mirrors the in-browser receipt preview built by `buildReceiptEl` in
 * public/assets/staff.js — same sections, same wording, same signature
 * placements. The browser preview is the canonical design; this file renders
 * a paper equivalent that gets attached to the job card at checkout.
 *
 * Layout (A4, portrait):
 *   1. Header strip     — CM logo + "Service Number / #XXXXXX"
 *   2. Info grid        — Customer / Device / Pricing subsections with labels
 *   3. Problem box      — free-text box showing the job description
 *   4. Consent + sigs   — drop-off + pick-up consent paragraphs with
 *                         signature lines (embedded sig image when captured)
 *   5. Standard charges — Inspection Fee / Fixed Charge strip
 *   6. Footer           — phone + "Service #X | Customer"
 *   7. T&Cs             — numbered list, 13 clauses
 */

import PDFDocument from 'pdfkit';
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import type { Job, PaymentMethod } from './job.js';
import { repairTotal, productTotal } from './job.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LOGO_PATH = join(__dirname, '..', 'public', 'assets', 'logo.jpg');

// ── Helpers ──────────────────────────────────────────────────────────────
const AUD = (n: number): string => `$${(Number(n) || 0).toFixed(2)}`;

function servicesText(job: Job): string {
  const parts: string[] = [];
  if (job.repair) {
    for (const l of job.repair.lines) {
      if (!l.service) continue;
      parts.push(`${l.service}${l.variant ? ` — ${l.variant}` : ''} (${AUD(l.cost)})`);
    }
    if (job.repair.customServiceName.trim() && (Number(job.repair.customServiceAmount) || 0) > 0) {
      parts.push(`${job.repair.customServiceName.trim()} (${AUD(job.repair.customServiceAmount)})`);
    }
  } else if (job.product) {
    for (const l of job.product.lines) {
      if (!l.name.trim()) continue;
      const qty = Number(l.qty) || 0;
      parts.push(`${qty}× ${l.name.trim()} @ ${AUD(l.unitPrice)}`);
    }
  } else if (job.onTheSpot) {
    const o = job.onTheSpot;
    if ((Number(o.price) || 0) > 0) parts.push(`${o.description || 'Quick fix'} (${AUD(o.price)})`);
    if ((Number(o.hours) || 0) > 0) {
      parts.push(`Labour — ${o.hours} hr${o.hours === 1 ? '' : 's'} @ ${AUD(o.hourlyRate)}/hr`);
    }
  } else if (job.pickup) {
    const selected = job.pickup.invoices.find(i => i.invoiceId === job.pickup!.selectedInvoiceId);
    if (selected) parts.push(`Balance on ${selected.invoiceNumber}: ${AUD(Number(selected.amountDue) || 0)}`);
    for (const l of job.pickup.extraLines) {
      if (!l.description.trim() && !(Number(l.amount) || 0)) continue;
      parts.push(`${l.description.trim() || 'Extra'} (${AUD(l.amount)})`);
    }
  }
  return parts.join(' • ');
}

function jobDescriptionFor(job: Job): string {
  if (job.repair) return job.repair.jobDescription || '';
  if (job.product) return job.product.notes || '';
  if (job.onTheSpot) return [job.onTheSpot.description, job.onTheSpot.notes].filter(Boolean).join(' — ');
  if (job.pickup) return job.pickup.extraNotes || '';
  return '';
}

function deviceStatusFor(job: Job): string {
  if (job.pickup) return 'Ready for pickup';
  if (job.onTheSpot) return 'Completed on-the-spot';
  if (job.product) return 'Product sale — no device';
  if (job.repair) return job.repair.paymentType === 'deposit' ? 'Booked in (deposit taken)' : 'Booked in';
  return '';
}

/** Compute order total, paid-so-far, and balance — same rules as preview. */
function totalsFor(job: Job): { total: number; deposit: number; balance: number } {
  let total = 0;
  let deposit = 0;
  if (job.repair) {
    total = repairTotal(job.repair);
    if (job.repair.paymentType === 'deposit') deposit = Number(job.repair.depositAmount) || 0;
  } else if (job.product) {
    total = productTotal(job.product);
    if (job.product.paymentType === 'deposit') deposit = Number(job.product.depositAmount) || 0;
  } else if (job.onTheSpot) {
    const o = job.onTheSpot;
    total = (Number(o.price) || 0) + (Number(o.hours) || 0) * (Number(o.hourlyRate) || 0);
    if (o.paymentType === 'deposit') deposit = Number(o.depositAmount) || 0;
  } else if (job.pickup) {
    const selected = job.pickup.invoices.find(i => i.invoiceId === job.pickup!.selectedInvoiceId);
    const invDue = Number(selected?.amountDue) || 0;
    const extras = job.pickup.extraLines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
    total = invDue + extras;
  }
  // If checkout succeeded, reflect what was actually paid.
  const paid = Number(job.checkout?.receipt?.amountPaid) || 0;
  if (paid > 0) deposit = paid;
  const balance = Math.max(0, total - deposit);
  return { total, deposit, balance };
}

function shortServiceNum(jobId: string): string {
  return (jobId || '').slice(-6).toUpperCase();
}

function fmtDate(iso: string | undefined): string {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return ''; }
}

// ── Main generator ───────────────────────────────────────────────────────
export interface GenerateReceiptOptions {
  job: Job;
  invoiceNumbers: string[];
  method: PaymentMethod;
  amountDueToday: number;
  amountPaid: number;
  cashTendered?: number;
  changeGiven?: number;
}

export function generateReceiptPdf(opts: GenerateReceiptOptions): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 36 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    try {
      renderReceipt(doc, opts);
    } catch (err) {
      reject(err);
      return;
    }
    doc.end();
  });
}

// ── Rendering ────────────────────────────────────────────────────────────

const PAGE_LEFT = 36;
const PAGE_RIGHT = 559; // A4 width (595) − right margin
const CONTENT_W = PAGE_RIGHT - PAGE_LEFT;

function renderReceipt(doc: PDFKit.PDFDocument, opts: GenerateReceiptOptions): void {
  const { job, invoiceNumbers } = opts;
  const serviceNum = shortServiceNum(job.id);
  const customerName = [job.customer.firstName, job.customer.lastName].filter(Boolean).join(' ');
  const totals = totalsFor(job);
  const services = servicesText(job);
  const jobDesc = jobDescriptionFor(job);
  const deviceStatus = deviceStatusFor(job);
  const dateStr = fmtDate(job.startedAt);
  const servedBy = job.startedBy?.name ?? '';
  const invoiceStr = invoiceNumbers.length
    ? invoiceNumbers.join(', ')
    : (job.pickup?.invoices.find(i => i.invoiceId === job.pickup!.selectedInvoiceId)?.invoiceNumber ?? '');

  // ── 1. Header ──────────────────────────────────────────────────────────
  const headerTop = doc.y;
  if (existsSync(LOGO_PATH)) {
    try {
      doc.image(LOGO_PATH, PAGE_LEFT, headerTop, { height: 46 });
    } catch { /* ignore logo errors — still render the rest */ }
  }
  doc.font('Helvetica').fontSize(9).fillColor('#000')
    .text('SERVICE NUMBER', PAGE_LEFT, headerTop + 6, { width: CONTENT_W, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(18).fillColor('#000')
    .text(`#${serviceNum}`, PAGE_LEFT, headerTop + 18, { width: CONTENT_W, align: 'right' });
  doc.y = headerTop + 54;
  doc.moveDown(0.3);

  // ── 2. Info grid ──────────────────────────────────────────────────────
  infoSection(doc, 'Customer & Job Details');
  gridRows(doc, [
    ['Name:', customerName],
    ['Email:', job.customer.email],
    ['Phone:', job.customer.phone],
    ['Postcode:', job.customer.postcode],
    ['Company:', job.customer.company],
    ['Booked in by:', servedBy],
  ]);

  infoSection(doc, 'Device');
  gridRows(doc, [
    ['Device:', job.repair?.deviceModel || ''],
    ['Items Taken:', ''],
    ['Date:', dateStr],
  ]);
  fullRow(doc, 'Issues:', '');
  if (job.customer.hasComputerPassword && job.customer.computerPassword) {
    fullRow(doc, 'Computer password:', job.customer.computerPassword);
  }

  infoSection(doc, 'Pricing');
  fullRow(doc, 'Services:', services);
  fullRow(doc, 'Job Description:', jobDesc);
  gridRows(doc, [
    ['Total:', AUD(totals.total), true],
    ['Deposit Paid:', AUD(totals.deposit)],
    ['Balance Due:', AUD(totals.balance), true],
    ['Invoice #:', invoiceStr],
    ['Device Status:', deviceStatus],
  ]);

  doc.moveDown(0.6);

  // ── 3. Problem description ────────────────────────────────────────────
  doc.font('Helvetica-Bold').fontSize(9.5).fillColor('#000')
    .text('Problem description:', PAGE_LEFT, doc.y);
  doc.moveDown(0.15);
  const boxY = doc.y;
  const boxH = 42;
  doc.lineWidth(0.7).strokeColor('#888').rect(PAGE_LEFT, boxY, CONTENT_W, boxH).stroke();
  doc.font('Helvetica').fontSize(9.5).fillColor('#000')
    .text(jobDesc || ' ', PAGE_LEFT + 6, boxY + 4, { width: CONTENT_W - 12, height: boxH - 8 });
  doc.y = boxY + boxH + 6;

  // ── 4. Consent + signatures ───────────────────────────────────────────
  doc.font('Helvetica').fontSize(8.5).fillColor('#000')
    .text(
      'I, the undersigned have read and agreed to the terms and conditions listed below. ' +
      'I hereby give authority to Computer Mechanics to proceed with the service requested above ' +
      'and agree to the terms listed below.',
      PAGE_LEFT, doc.y, { width: CONTENT_W, lineGap: 1 },
    );
  doc.moveDown(0.2);
  signatureRow(doc, job, 'drop_off', customerName);

  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(8.5).fillColor('#000')
    .text(
      'I, the undersigned am satisfied that the above work has been completed as requested.',
      PAGE_LEFT, doc.y, { width: CONTENT_W, lineGap: 1 },
    );
  doc.moveDown(0.2);
  signatureRow(doc, job, 'pick_up', customerName);

  doc.moveDown(0.4);

  // ── 5. Standard charges strip ─────────────────────────────────────────
  standardChargesStrip(doc);

  // ── 6. Footer line ────────────────────────────────────────────────────
  doc.moveDown(0.3);
  doc.font('Helvetica').fontSize(8).fillColor('#444');
  const footerY = doc.y;
  doc.text('Computer Mechanics — Telephone (08) 9325 1196', PAGE_LEFT, footerY, { width: CONTENT_W / 2 });
  doc.text(`Service #${serviceNum}  |  ${customerName}`, PAGE_LEFT + CONTENT_W / 2, footerY, {
    width: CONTENT_W / 2, align: 'right',
  });
  doc.y = footerY + 12;

  // ── 7. T&Cs ───────────────────────────────────────────────────────────
  doc.moveDown(0.3);
  doc.font('Helvetica-Bold').fontSize(10).fillColor('#000').text('Terms & Conditions of Service', PAGE_LEFT);
  doc.moveDown(0.1);
  doc.font('Helvetica').fontSize(7.5).fillColor('#000').text('The client acknowledges that:', PAGE_LEFT);
  doc.moveDown(0.15);
  termsList(doc);
}

// ── Section helpers ──────────────────────────────────────────────────────

function infoSection(doc: PDFKit.PDFDocument, title: string): void {
  doc.moveDown(0.25);
  const y = doc.y;
  doc.rect(PAGE_LEFT, y, CONTENT_W, 13).fill('#000');
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#fff')
    .text(title, PAGE_LEFT + 6, y + 2.5, { width: CONTENT_W - 12 });
  doc.fillColor('#000');
  doc.y = y + 13;
  doc.moveDown(0.1);
}

/**
 * Render a short label/value row spanning the full content width. Used for
 * long-form fields (services text, problem description).
 */
function fullRow(doc: PDFKit.PDFDocument, label: string, value: string, bold = false): void {
  const y = doc.y;
  const labelW = 110;
  doc.font('Helvetica-Bold').fontSize(9).fillColor('#000')
    .text(label, PAGE_LEFT + 4, y, { width: labelW });
  const valueX = PAGE_LEFT + 4 + labelW;
  const valueW = CONTENT_W - 8 - labelW;
  doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).fillColor('#000')
    .text(value || ' ', valueX, y, { width: valueW });
  const h = Math.max(11, doc.y - y);
  // Underline under value
  const underlineY = y + h - 1;
  doc.lineWidth(0.5).strokeColor('#888')
    .moveTo(valueX, underlineY).lineTo(valueX + valueW, underlineY).stroke();
  doc.y = y + h + 2;
}

/**
 * Render a two-column grid of [label, value] pairs. Entries with a trailing
 * `true` element are bolded. Falls back to a single column for odd counts.
 */
function gridRows(doc: PDFKit.PDFDocument, rows: Array<[string, string] | [string, string, boolean]>): void {
  const colW = CONTENT_W / 2;
  const labelW = 90;
  for (let i = 0; i < rows.length; i += 2) {
    const y = doc.y;
    const left = rows[i];
    const right = rows[i + 1];
    for (const [col, row] of [[0, left], [1, right]] as const) {
      if (!row) continue;
      const [label, value, bold] = row as [string, string, boolean | undefined];
      const x = PAGE_LEFT + col * colW;
      doc.font('Helvetica-Bold').fontSize(9).fillColor('#000')
        .text(label, x + 4, y, { width: labelW });
      const valueX = x + 4 + labelW;
      const valueW = colW - 8 - labelW;
      doc.font(bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(9.5).fillColor('#000')
        .text(value || ' ', valueX, y, { width: valueW });
      // Underline
      doc.lineWidth(0.5).strokeColor('#888')
        .moveTo(valueX, y + 11).lineTo(valueX + valueW, y + 11).stroke();
    }
    doc.y = y + 13;
  }
}

/**
 * Render a "Signature / Print Name / Date" row. If the customer captured a
 * signature on the customer-facing screen, embed the image across the line
 * and fill the name + date. Otherwise draw blank lines for pen-on-paper.
 */
function signatureRow(doc: PDFKit.PDFDocument, job: Job, kind: 'drop_off' | 'pick_up', name: string): void {
  const slot = kind === 'drop_off' ? 'dropOff' : 'pickUp';
  const sig = job.signatures?.[slot] ?? null;
  let dateStr = '';
  if (sig?.signedAt) dateStr = fmtDate(sig.signedAt);

  const y = doc.y;
  const labelFont = () => doc.font('Helvetica').fontSize(9).fillColor('#000');

  // Signature (wide)
  labelFont().text('Signature:', PAGE_LEFT, y);
  const sigX = PAGE_LEFT + 52;
  const sigW = 170;
  const sigBaseline = y + 14;
  doc.lineWidth(1).strokeColor('#000')
    .moveTo(sigX, sigBaseline).lineTo(sigX + sigW, sigBaseline).stroke();
  if (sig?.dataUrl) {
    // Strip "data:image/png;base64," prefix and embed.
    const b64 = sig.dataUrl.replace(/^data:image\/[a-z]+;base64,/i, '');
    try {
      const imgBuf = Buffer.from(b64, 'base64');
      // Float the image so it sits on the line, roughly filling it.
      doc.image(imgBuf, sigX + 2, y - 2, { fit: [sigW - 4, 20] });
    } catch { /* ignore bad image */ }
  }

  // Print Name
  const nameX = sigX + sigW + 20;
  const nameW = 130;
  labelFont().text('Print Name:', nameX, y);
  const nameValX = nameX + 60;
  doc.lineWidth(1).strokeColor('#000')
    .moveTo(nameValX, sigBaseline).lineTo(nameValX + nameW - 60, sigBaseline).stroke();
  if (sig) {
    doc.font('Helvetica').fontSize(9).fillColor('#000')
      .text(name, nameValX + 2, y, { width: nameW - 62 });
  }

  // Date
  const dateX = nameX + nameW + 20;
  const dateW = 100;
  labelFont().text('Date:', dateX, y);
  const dateValX = dateX + 28;
  doc.lineWidth(1).strokeColor('#000')
    .moveTo(dateValX, sigBaseline).lineTo(dateValX + dateW - 28, sigBaseline).stroke();
  if (sig) {
    doc.font('Helvetica').fontSize(9).fillColor('#000')
      .text(dateStr, dateValX + 2, y, { width: dateW - 30 });
  }

  doc.y = y + 20;
}

function standardChargesStrip(doc: PDFKit.PDFDocument): void {
  const y = doc.y;
  const stripH = 36;
  const headW = 110;
  doc.lineWidth(1.5).strokeColor('#000').rect(PAGE_LEFT, y, CONTENT_W, stripH).stroke();

  // Black "Standard Charges" header cell
  doc.rect(PAGE_LEFT, y, headW, stripH).fill('#000');
  doc.font('Helvetica-Bold').fontSize(8.5).fillColor('#fff')
    .text('STANDARD\nCHARGES', PAGE_LEFT + 6, y + 8, { width: headW - 12, align: 'center' });

  // Cells
  const cells = [
    { label: 'Inspection Fee', amount: '$85.00' },
    { label: 'Fixed Charge',   amount: '$175.00' },
  ];
  const cellW = (CONTENT_W - headW) / cells.length;
  cells.forEach((c, i) => {
    const x = PAGE_LEFT + headW + i * cellW;
    if (i > 0) {
      doc.lineWidth(1).strokeColor('#000')
        .moveTo(x, y).lineTo(x, y + stripH).stroke();
    }
    doc.font('Helvetica-Bold').fontSize(8).fillColor('#000')
      .text(c.label.toUpperCase(), x, y + 4, { width: cellW, align: 'center', characterSpacing: 0.3 });
    doc.font('Helvetica-Bold').fontSize(12).fillColor('#000')
      .text(c.amount, x, y + 14, { width: cellW, align: 'center' });
    doc.font('Helvetica').fontSize(7.5).fillColor('#333')
      .text('inc. GST', x, y + 27, { width: cellW, align: 'center' });
  });

  doc.y = y + stripH + 2;
}

const TERMS: string[] = [
  'The client requests that Computer Mechanics perform the above work and examine and rectify, if able, the above faults.',
  'If any equipment or a faulty component forming part of the equipment is not under warranty, or if the warranty has been voided by the customer in any way, then the minimum service charge plus labour charges at the current hourly rate will apply, even if the fault is not fixed.',
  'If any fault with the equipment is not due to a manufacturers hardware defect, then the minimum service charges at the current hourly rate will apply, even if the fault is not rectified, even if the equipment is still under warranty.',
  'Computer Mechanics are authorized to complete any work up to the amount of $220 without prior notification. NOTE: All faults due to software errors and viruses are specifically not covered under warranty.',
  'No work further to the above charges will be performed without prior consent of the client. If so authorised, charges will be at the current rate, plus parts.',
  'In no event will Computer Mechanics be liable for any damages, lost profits, lost savings, lost data or other incidental or consequent damages.',
  'If after a period of (2) months the tendered equipment has not been collected then Computer Mechanics shall take the necessary steps pursuant to the Disposal of Uncollected Goods Act, 1970.',
  'Credit card payments will incur a 2.5% surcharge of the total amount of the invoice.',
  'Goods presented for repair may be replaced by refurbished goods of the same type rather than being repaired.',
  'Any computers found to be non operational and the repair is not approved, a further $77 will be charged for re-assembly.',
  "Due to the nature of data recovery, Computer Mechanics can't guarantee all files and folders will be recovered or in a readable or structured state.",
  'Part order times are estimates only.',
  'Full Terms & Conditions available at http://www.computermechanics.com.au/terms-and-conditions/',
];

function termsList(doc: PDFKit.PDFDocument): void {
  doc.font('Helvetica').fontSize(7.3).fillColor('#000');
  const numW = 14;
  const itemW = CONTENT_W - numW;
  for (let i = 0; i < TERMS.length; i++) {
    const y = doc.y;
    doc.text(`${i + 1}.`, PAGE_LEFT, y, { width: numW });
    doc.text(TERMS[i], PAGE_LEFT + numW, y, { width: itemW, lineGap: 0.5 });
    doc.moveDown(0.1);
  }
}
