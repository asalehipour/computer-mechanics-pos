/**
 * Per-staff "active job" state. Each logged-in staff user has their own
 * in-flight Job keyed by Microsoft Entra `oid`. This lets multiple staff work
 * concurrent jobs (e.g. phone bookings from one PC while a walk-in is served
 * on another) without their state colliding.
 *
 * The customer-facing screen pairs with a specific staff via the `?staff=<oid>`
 * query param; see ws.ts for the subscribe protocol.
 */

import { getXeroClient, seedPickupTestInvoice } from './integrations/xero.js';
import { getTyroClient } from './integrations/tyro.js';
import { getEmailClient } from './integrations/email.js';
import type { Contact, Invoice, LineItem } from './integrations/types.js';
import { savePassword } from './passwords.js';
import {
  createEntry as boardCreateEntry,
  completeEntryForPickup as boardCompleteForPickup,
  addAttachment as boardAddAttachment,
  getActiveEntriesForContact as boardGetActiveForContact,
  type BoardFlow,
  type BoardEntry,
  type BoardStatus,
} from './job-board.js';
import { generateReceiptPdf } from './receipt-pdf.js';
import { nextJobNumber } from './counter.js';

export type Route = 'repair' | 'product' | 'on_the_spot' | 'pickup';
export type Step =
  | 'dashboard'
  | 'intake'
  | 'route'
  | 'repair'
  | 'product'
  | 'on_the_spot'
  | 'pickup'
  | 'checkout'
  | 'done';

export type PaymentType = 'full' | 'deposit';

/**
 * One service row in a repair job. `service` is the dropdown label (e.g.
 * "Screen Replacement"), `variant` captures sub-selections like "Touchscreen"
 * or "512GB". `cost` is always GST-inclusive dollars.
 */
export interface ServiceLine {
  id: string;
  service: string;
  variant: string;
  cost: number;
}

export interface RepairDetails {
  lines: ServiceLine[];
  /** Customer's device, e.g. "HP Envy x360 15-EY". Printed on the receipt. */
  deviceModel: string;
  jobDescription: string;
  customServiceName: string;
  customServiceAmount: number;
  paymentType: PaymentType | null;
  depositAmount: number;
}

const EMPTY_REPAIR: RepairDetails = {
  lines: [],
  deviceModel: '',
  jobDescription: '',
  customServiceName: '',
  customServiceAmount: 0,
  paymentType: null,
  depositAmount: 0,
};

const REPAIR_FIELDS = new Set<keyof RepairDetails>([
  'deviceModel', 'jobDescription', 'customServiceName', 'customServiceAmount', 'paymentType', 'depositAmount',
]);
export function isRepairField(f: string): f is keyof RepairDetails {
  return REPAIR_FIELDS.has(f as keyof RepairDetails);
}

const REPAIR_LINE_FIELDS = new Set<keyof ServiceLine>(['service', 'variant', 'cost']);
export function isRepairLineField(f: string): f is keyof ServiceLine {
  return REPAIR_LINE_FIELDS.has(f as keyof ServiceLine);
}

/** One product row in a product sale. `unitPrice` is GST-inclusive dollars. */
export interface ProductLine {
  id: string;
  name: string;
  qty: number;
  unitPrice: number;
}

export interface ProductDetails {
  lines: ProductLine[];
  notes: string;
  paymentType: PaymentType | null;
  depositAmount: number;
}

const EMPTY_PRODUCT: ProductDetails = {
  lines: [],
  notes: '',
  paymentType: null,
  depositAmount: 0,
};

const PRODUCT_FIELDS = new Set<keyof ProductDetails>([
  'notes', 'paymentType', 'depositAmount',
]);
export function isProductField(f: string): f is keyof ProductDetails {
  return PRODUCT_FIELDS.has(f as keyof ProductDetails);
}

const PRODUCT_LINE_FIELDS = new Set<keyof ProductLine>(['name', 'qty', 'unitPrice']);
export function isProductLineField(f: string): f is keyof ProductLine {
  return PRODUCT_LINE_FIELDS.has(f as keyof ProductLine);
}

/**
 * On-the-spot: a quick fix done while the customer waits.
 * Fixed-fee `price` covers quick-fix items; hourly charge covers time-based work
 * (e.g. diagnostic hours). Total billed = price + hours * hourlyRate.
 * The board card for this flow goes to the "On the spot" column, not "Booked in".
 */
export interface OnTheSpotDetails {
  description: string;
  price: number;
  hours: number;
  hourlyRate: number;
  notes: string;
  paymentType: PaymentType | null;
  depositAmount: number;
}

const EMPTY_ON_THE_SPOT: OnTheSpotDetails = {
  description: '',
  price: 0,
  hours: 0,
  hourlyRate: 175,
  notes: '',
  // On-the-spot is almost always paid immediately, so default to 'full'.
  paymentType: 'full',
  depositAmount: 0,
};

const ON_THE_SPOT_FIELDS = new Set<keyof OnTheSpotDetails>([
  'description', 'price', 'hours', 'hourlyRate', 'notes', 'paymentType', 'depositAmount',
]);
export function isOnTheSpotField(f: string): f is keyof OnTheSpotDetails {
  return ON_THE_SPOT_FIELDS.has(f as keyof OnTheSpotDetails);
}

/**
 * Pickup: customer returns to collect a device. We list their open Xero
 * invoices (looked up by contactId from Step 1) so staff can pick the right
 * one. If the actual work cost more than the quoted/deposit invoice, staff
 * can add extra charges — these become a second invoice at checkout.
 */
export interface PickupExtraLine {
  id: string;
  description: string;
  amount: number;
}

export type PickupLoadState = 'loading' | 'loaded' | 'empty' | 'error';

/**
 * A single active job for this customer, with the invoices attached to it.
 * Serialized to the client so the pickup screen can show a job → invoices
 * tree instead of a flat invoice list.
 */
export interface PickupJobGroup {
  /** BoardEntry.id — used as the identifier for selection + UI keys. */
  entryId: string;
  /** Short 4-char job id (back-compat). */
  jobId: string;
  /** Human-friendly sequential number — rendered as "Ticket #1052". */
  displayNumber: number | null;
  deviceModel: string;
  deviceEmoji: string;
  status: BoardStatus;
  /** Updated-at / created-at so the UI can sort and show "opened X days ago". */
  createdAt: string;
  updatedAt: string;
  /** Xero invoices attached to this job, cross-referenced from contactId. */
  invoices: Invoice[];
}

export interface PickupDetails {
  loadState: PickupLoadState;
  loadError: string | null;
  /**
   * Grouped view: one item per active board entry for this customer.
   * Primary source of truth for the new pickup screen.
   */
  jobGroups: PickupJobGroup[];
  /**
   * Flat invoice list. Still populated for the fallback path (customer has
   * no active board entries but has open Xero invoices — e.g. pre-board
   * jobs or external invoices) so the UI can render a legacy flat picker.
   */
  invoices: Invoice[];
  /**
   * True when `invoices` came from the Xero-only fallback (no job groups
   * matched). Lets the UI explain "we couldn't find an active job for this
   * customer — here are their open Xero invoices instead."
   */
  isFallback: boolean;
  selectedInvoiceId: string | null;
  /** Which job group the selected invoice belongs to (null on fallback). */
  selectedEntryId: string | null;
  extraLines: PickupExtraLine[];
  extraNotes: string;
}

const EMPTY_PICKUP: PickupDetails = {
  loadState: 'loading',
  loadError: null,
  jobGroups: [],
  invoices: [],
  isFallback: false,
  selectedInvoiceId: null,
  selectedEntryId: null,
  extraLines: [],
  extraNotes: '',
};

const PICKUP_FIELDS = new Set<keyof PickupDetails>(['extraNotes']);
export function isPickupField(f: string): f is 'extraNotes' {
  return PICKUP_FIELDS.has(f as keyof PickupDetails);
}

const PICKUP_LINE_FIELDS = new Set<keyof PickupExtraLine>(['description', 'amount']);
export function isPickupLineField(f: string): f is 'description' | 'amount' {
  return PICKUP_LINE_FIELDS.has(f as keyof PickupExtraLine);
}

const ROUTES: readonly Route[] = ['repair', 'product', 'on_the_spot', 'pickup'];
export function isRoute(x: unknown): x is Route {
  return typeof x === 'string' && (ROUTES as readonly string[]).includes(x);
}

/**
 * Checkout: the terminal step for every flow. State machine:
 *   choosing → cash_entry → processing → done
 *   choosing → card_charging → card_declined → (back to choosing)
 *                            → processing → done
 *   choosing → (pick pay_later) → processing → done
 *   processing → error (any integration failure)
 */
export type PaymentMethod = 'cash' | 'card' | 'pay_later';
export type CheckoutState =
  | 'choosing' | 'cash_entry' | 'card_charging' | 'card_declined'
  | 'processing' | 'done' | 'error';

export interface CheckoutReceipt {
  method: PaymentMethod;
  amountDueToday: number;   // what we asked for (full/deposit)
  amountPaid: number;       // 0 for pay_later, else == amountDueToday
  invoiceNumbers: string[];
  cardType?: string;
  cardLastFour?: string;
  transactionRef?: string;
  cashTendered?: number;
  changeGiven?: number;
  reviewEmailScheduledAt?: string;
}

export interface CheckoutDetails {
  state: CheckoutState;
  method: PaymentMethod | null;
  cashTendered: number;
  declineReason: string | null;
  error: string | null;
  receipt: CheckoutReceipt | null;
}

const EMPTY_CHECKOUT: CheckoutDetails = {
  state: 'choosing',
  method: null,
  cashTendered: 0,
  declineReason: null,
  error: null,
  receipt: null,
};

/**
 * Where the device is physically during the job.
 *
 *   taking   — Customer is keeping the device; we're ordering parts and will
 *              call them back when parts arrive.
 *   leaving  — Customer has left the device with us for repair.
 *   na       — Not applicable (product sale, pickup, quick on-the-spot work
 *              that doesn't involve the customer's device, etc.).
 *
 * Captured on Step 1 before going to the router, and surfaced on the job
 * card so anyone can see / change it later as plans shift.
 */
export type DeviceIntent = 'taking' | 'leaving' | 'na';

export interface CustomerDetails {
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  postcode: string;
  company: string;
  hasComputerPassword: boolean;
  /** Plaintext, kept in memory for the session so the staff receipt can print it.
   *  Stripped from customer-facing broadcasts by toCustomerFacing(). The durable
   *  copy is AES-256-GCM encrypted in the password store (see passwords.ts). */
  computerPassword: string;
  /** Is the customer taking the device home or leaving it with us? Null until
   *  the staff answers the question on Step 1. */
  deviceIntent: DeviceIntent | null;
}

export function isDeviceIntent(x: unknown): x is DeviceIntent {
  return x === 'taking' || x === 'leaving' || x === 'na';
}

/**
 * Customer-captured consent signatures.
 *
 *   drop_off — "I authorise you to proceed" (signed before the device is left
 *              in our care). Applies to repair/product/on_the_spot flows.
 *   pick_up  — "I'm satisfied with the work" (signed on collection).
 *              Applies to the pickup flow.
 *
 * Stored as base64 PNG data URLs — small enough to fit on the Job in-memory
 * and render directly on the receipt without a separate file store.
 */
export type SignatureKind = 'drop_off' | 'pick_up';

export interface Signature {
  kind: SignatureKind;
  /** `data:image/png;base64,…` — sized to fit the receipt signature line. */
  dataUrl: string;
  signedAt: string;
}

export interface SignatureRequest {
  kind: SignatureKind;
  requestedAt: string;
}

export interface JobSignatures {
  dropOff: Signature | null;
  pickUp: Signature | null;
}

export interface Job {
  id: string;
  /**
   * Human-friendly sequential number (1051, 1052, …). Used as the public
   * "Service Number" on receipts, customer emails, and the job board. Kept
   * alongside the opaque `id` rather than replacing it so existing jobs
   * loaded from older data files (where this was undefined) still work.
   */
  displayNumber: number;
  step: Step;
  customer: CustomerDetails;
  contactId: string | null;
  isExistingContact: boolean;
  startedAt: string;
  startedBy: { name: string; email: string };
  /** Populated on entering 'repair' step; null for other routes. */
  repair: RepairDetails | null;
  /** Populated on entering 'product' step; null for other routes. */
  product: ProductDetails | null;
  /** Populated on entering 'on_the_spot' step; null for other routes. */
  onTheSpot: OnTheSpotDetails | null;
  /** Populated on entering 'pickup' step; null for other routes. */
  pickup: PickupDetails | null;
  /** Populated when a flow advances into 'checkout'; persists across back-and-forth. */
  checkout: CheckoutDetails | null;
  /** Set after Step 1 submit if a computer password was provided — points at
   *  the encrypted record in passwords.json. Plaintext is cleared from
   *  customer.computerPassword once saved. */
  passwordRecordId: string | null;
  /** Drop-off + pick-up consent signatures (captured on the customer screen). */
  signatures: JobSignatures;
  /** If non-null, the customer screen shows a signature pad. Set by staff. */
  signatureRequest: SignatureRequest | null;
}

/** Customer-screen view of a job — strips fields the customer shouldn't see on a public-facing monitor. */
export type CustomerFacingJob = Omit<Job, 'customer' | 'startedBy'> & {
  customer: Omit<CustomerDetails, 'computerPassword'>;
};

const EMPTY_CUSTOMER: CustomerDetails = {
  firstName: '',
  lastName: '',
  phone: '',
  email: '',
  postcode: '',
  company: '',
  hasComputerPassword: false,
  computerPassword: '',
  deviceIntent: null,
};

const jobsByUser = new Map<string, Job>();

type Listener = (userKey: string, job: Job | null) => void;
const listeners = new Set<Listener>();

export function onJobChange(fn: Listener): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

function emit(userKey: string): void {
  const job = jobsByUser.get(userKey) ?? null;
  for (const l of listeners) l(userKey, job);
}

function shortId(): string {
  return Math.random().toString(36).slice(2, 6).toUpperCase();
}

export function getCurrentJob(userKey: string): Job | null {
  return jobsByUser.get(userKey) ?? null;
}

/** Internal: apply an update to a user's active job. Returns null if they
 *  don't have one. Emits on success so subscribers see the new state. */
function withJob(userKey: string, fn: (j: Job) => Job): Job | null {
  const cur = jobsByUser.get(userKey);
  if (!cur) return null;
  const next = fn(cur);
  jobsByUser.set(userKey, next);
  emit(userKey);
  return next;
}

export function startNewJob(userKey: string, staff: { name: string; email: string }): Job {
  const job: Job = {
    id: shortId(),
    displayNumber: nextJobNumber(),
    step: 'intake',
    customer: { ...EMPTY_CUSTOMER },
    contactId: null,
    isExistingContact: false,
    startedAt: new Date().toISOString(),
    startedBy: staff,
    repair: null,
    product: null,
    onTheSpot: null,
    pickup: null,
    checkout: null,
    passwordRecordId: null,
    signatures: { dropOff: null, pickUp: null },
    signatureRequest: null,
  };
  jobsByUser.set(userKey, job);
  emit(userKey);
  return job;
}

export function clearJob(userKey: string): void {
  jobsByUser.delete(userKey);
  emit(userKey);
}

const CUSTOMER_FIELDS = new Set<keyof CustomerDetails>([
  'firstName', 'lastName', 'phone', 'email', 'postcode', 'company',
  'hasComputerPassword', 'computerPassword', 'deviceIntent',
]);

export function isCustomerField(field: string): field is keyof CustomerDetails {
  return CUSTOMER_FIELDS.has(field as keyof CustomerDetails);
}

export function updateCustomerField<K extends keyof CustomerDetails>(
  userKey: string,
  field: K,
  value: CustomerDetails[K],
): Job | null {
  return withJob(userKey, cur => ({
    ...cur,
    customer: {
      ...cur.customer,
      [field]: value,
      // If they tick "no password", clear any password that was typed.
      ...(field === 'hasComputerPassword' && value === false ? { computerPassword: '' } : {}),
    },
  }));
}

// ── Signature capture ───────────────────────────────────────────────────────

const SIGNATURE_KINDS: readonly SignatureKind[] = ['drop_off', 'pick_up'];
export function isSignatureKind(x: unknown): x is SignatureKind {
  return typeof x === 'string' && (SIGNATURE_KINDS as readonly string[]).includes(x);
}

/** Tell the customer screen to show its signature pad. Staff-initiated. */
export function requestSignature(userKey: string, kind: SignatureKind): Job | null {
  return withJob(userKey, cur => ({
    ...cur,
    signatureRequest: { kind, requestedAt: new Date().toISOString() },
  }));
}

/** Staff cancels a pending request (e.g. changed their mind). */
export function cancelSignatureRequest(userKey: string): Job | null {
  return withJob(userKey, cur => cur.signatureRequest ? { ...cur, signatureRequest: null } : cur);
}

const MAX_SIGNATURE_BYTES = 1_500_000; // ~1.1MB raw; generous for a PNG signature.
const PNG_DATA_URL_PREFIX = 'data:image/png;base64,';

/** Customer screen submits a captured signature. Idempotent on `kind`. */
export function submitSignature(userKey: string, kind: SignatureKind, dataUrl: string): Job | null {
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith(PNG_DATA_URL_PREFIX)) return getCurrentJob(userKey);
  if (dataUrl.length > MAX_SIGNATURE_BYTES) return getCurrentJob(userKey);
  const sig: Signature = { kind, dataUrl, signedAt: new Date().toISOString() };
  const slot = kind === 'drop_off' ? 'dropOff' : 'pickUp';
  return withJob(userKey, cur => ({
    ...cur,
    signatures: { ...cur.signatures, [slot]: sig },
    // Clear the pending request if it matched this kind.
    signatureRequest:
      cur.signatureRequest?.kind === kind ? null : cur.signatureRequest,
  }));
}

/** Staff clears a captured signature (e.g. to redo). */
export function clearSignature(userKey: string, kind: SignatureKind): Job | null {
  const slot = kind === 'drop_off' ? 'dropOff' : 'pickUp';
  return withJob(userKey, cur => ({
    ...cur,
    signatures: { ...cur.signatures, [slot]: null },
  }));
}

export function setStep(userKey: string, step: Step): Job | null {
  return withJob(userKey, cur => ({ ...cur, step }));
}

/** Transition from the router screen into one of the four flows. */
export function chooseRoute(userKey: string, route: Route): Job | null {
  const result = withJob(userKey, cur => {
    if (cur.step !== 'route') return cur;
    // Initialize route-specific state on first entry; preserve on back-and-forth.
    let next = { ...cur, step: route as Step };
    if (route === 'repair' && !next.repair) {
      next = { ...next, repair: { ...EMPTY_REPAIR, lines: [newLine()] } };
    }
    if (route === 'product' && !next.product) {
      next = { ...next, product: { ...EMPTY_PRODUCT, lines: [newProductLine()] } };
    }
    if (route === 'on_the_spot' && !next.onTheSpot) {
      next = { ...next, onTheSpot: { ...EMPTY_ON_THE_SPOT } };
    }
    if (route === 'pickup' && !next.pickup) {
      next = { ...next, pickup: { ...EMPTY_PICKUP } };
    }
    return next;
  });
  // Kick off the async invoice fetch after we've emitted the 'loading' state
  // so the UI can show its spinner immediately.
  if (route === 'pickup' && result?.pickup?.loadState === 'loading') {
    void pickupLoadInvoices(userKey);
  }
  return result;
}

/** Go back from a flow placeholder to the four-option router. */
export function backToRouter(userKey: string): Job | null {
  return withJob(userKey, cur => isRoute(cur.step) ? { ...cur, step: 'route' } : cur);
}

/**
 * From the checkout step, return to the originating flow so staff can edit
 * services/pricing without losing any data entered.
 */
export function backFromCheckout(userKey: string): Job | null {
  return withJob(userKey, cur => {
    if (cur.step !== 'checkout') return cur;
    // Infer the flow from populated state.
    let nextStep: Step = 'route';
    if (cur.repair) nextStep = 'repair';
    else if (cur.product) nextStep = 'product';
    else if (cur.onTheSpot) nextStep = 'on_the_spot';
    else if (cur.pickup) nextStep = 'pickup';
    return { ...cur, step: nextStep };
  });
}

export type SubmitStep1Result =
  | { ok: true; contactId: string; isExistingContact: boolean; contactName: string; job: Job }
  | { ok: false; error: string; missing?: string[] };

export async function submitStep1(userKey: string): Promise<SubmitStep1Result> {
  const initial = getCurrentJob(userKey);
  if (!initial) return { ok: false, error: 'no_active_job' };
  const c = initial.customer;

  const missing: string[] = [];
  if (!c.firstName.trim()) missing.push('firstName');
  if (!c.lastName.trim()) missing.push('lastName');
  if (!c.email.trim()) missing.push('email');
  if (!c.phone.trim()) missing.push('phone');
  if (missing.length) return { ok: false, error: 'missing_required_fields', missing };

  const xero = getXeroClient();
  let contact: Contact | null = await xero.findContactByEmail(c.email);
  let isExisting = Boolean(contact);
  if (!contact) {
    contact = await xero.findContactByName(c.firstName, c.lastName);
    if (contact) isExisting = true;
  }
  if (!contact) {
    contact = await xero.createContact({
      firstName: c.firstName.trim(),
      lastName: c.lastName.trim(),
      email: c.email.trim(),
      phone: c.phone.trim(),
      postcode: c.postcode.trim() || undefined,
      company: c.company.trim() || undefined,
    });
  }

  // Encrypt + persist the computer password (if one was entered). The plaintext
  // stays on the in-memory job for the lifetime of the session so the staff
  // receipt can print it; it's stripped from customer-facing broadcasts by
  // toCustomerFacing(). The encrypted record is the durable copy used for
  // audited reveal after the session ends.
  let passwordRecordId: string | null = initial.passwordRecordId;
  if (c.hasComputerPassword && c.computerPassword.trim() && !passwordRecordId) {
    try {
      passwordRecordId = await savePassword({
        plaintext: c.computerPassword,
        jobId: initial.id,
        contactId: contact.contactId,
        customerEmail: c.email.trim(),
        customerName: `${c.firstName.trim()} ${c.lastName.trim()}`,
        createdBy: initial.startedBy,
      });
    } catch (err) {
      // Non-fatal — surface to staff but don't block the job advancing. They
      // can retry by toggling the password checkbox off/n and resubmitting.
      console.error('[job] Failed to save computer password:', err);
    }
  }

  // Guard: job may have been cleared/replaced during the await.
  const updated = withJob(userKey, cur =>
    cur.id === initial.id
      ? { ...cur, contactId: contact!.contactId, isExistingContact: isExisting, step: 'route', passwordRecordId }
      : cur,
  );
  if (!updated) return { ok: false, error: 'job_disappeared' };
  return {
    ok: true,
    contactId: contact.contactId,
    isExistingContact: isExisting,
    contactName: `${contact.firstName} ${contact.lastName}`,
    job: updated,
  };
}

// ── Repair flow ─────────────────────────────────────────────────────────────

function newLine(): ServiceLine {
  return { id: shortId(), service: '', variant: '', cost: 0 };
}

function withRepair(userKey: string, fn: (r: RepairDetails) => RepairDetails): Job | null {
  return withJob(userKey, cur => cur.repair ? { ...cur, repair: fn(cur.repair) } : cur);
}

export function repairAddLine(userKey: string): Job | null {
  return withRepair(userKey, r => ({ ...r, lines: [...r.lines, newLine()] }));
}

export function repairRemoveLine(userKey: string, lineId: string): Job | null {
  return withRepair(userKey, r => ({
    ...r,
    // Never delete the last line — the form always shows at least one row.
    lines: r.lines.length > 1 ? r.lines.filter(l => l.id !== lineId) : r.lines,
  }));
}

export function repairUpdateLine<K extends keyof ServiceLine>(
  userKey: string, lineId: string, field: K, value: ServiceLine[K],
): Job | null {
  return withRepair(userKey, r => ({
    ...r,
    lines: r.lines.map(l => l.id === lineId ? { ...l, [field]: value } : l),
  }));
}

export function repairUpdateField<K extends keyof RepairDetails>(
  userKey: string, field: K, value: RepairDetails[K],
): Job | null {
  return withRepair(userKey, r => {
    const next = { ...r, [field]: value };
    // Clearing payment type clears any deposit that was entered.
    if (field === 'paymentType' && value !== 'deposit') next.depositAmount = 0;
    return next;
  });
}

/** Compute the live total (inc. GST) from current repair state. */
export function repairTotal(r: RepairDetails): number {
  const lineSum = r.lines.reduce((sum, l) => sum + (Number(l.cost) || 0), 0);
  const custom = Number(r.customServiceAmount) || 0;
  return Math.round((lineSum + custom) * 100) / 100;
}

export type SubmitRepairResult =
  | { ok: true; job: Job }
  | { ok: false; error: string; detail?: string };

export function submitRepair(userKey: string): SubmitRepairResult {
  const cur = getCurrentJob(userKey);
  if (!cur) return { ok: false, error: 'no_active_job' };
  if (cur.step !== 'repair') return { ok: false, error: 'wrong_step' };
  const r = cur.repair;
  if (!r) return { ok: false, error: 'no_repair_state' };

  const validLines = r.lines.filter(l => l.service.trim().length > 0);
  if (validLines.length === 0 && !r.customServiceName.trim()) {
    return { ok: false, error: 'no_services', detail: 'Add at least one service or a custom line.' };
  }
  if (!r.jobDescription.trim()) {
    return { ok: false, error: 'missing_description', detail: 'Describe what work needs to be done.' };
  }
  if (!r.paymentType) {
    return { ok: false, error: 'missing_payment_type', detail: 'Choose Paying in full or Leaving a deposit.' };
  }
  if (r.paymentType === 'deposit' && (!r.depositAmount || r.depositAmount <= 0)) {
    return { ok: false, error: 'missing_deposit', detail: 'Enter a deposit amount.' };
  }

  const updated = withJob(userKey, c => ({
    ...c,
    step: 'checkout',
    checkout: c.checkout ?? { ...EMPTY_CHECKOUT },
  }));
  if (!updated) return { ok: false, error: 'no_active_job' };
  return { ok: true, job: updated };
}

// ── Product flow ────────────────────────────────────────────────────────────

function newProductLine(): ProductLine {
  return { id: shortId(), name: '', qty: 1, unitPrice: 0 };
}

function withProduct(userKey: string, fn: (p: ProductDetails) => ProductDetails): Job | null {
  return withJob(userKey, cur => cur.product ? { ...cur, product: fn(cur.product) } : cur);
}

export function productAddLine(userKey: string): Job | null {
  return withProduct(userKey, p => ({ ...p, lines: [...p.lines, newProductLine()] }));
}

export function productRemoveLine(userKey: string, lineId: string): Job | null {
  return withProduct(userKey, p => ({
    ...p,
    lines: p.lines.length > 1 ? p.lines.filter(l => l.id !== lineId) : p.lines,
  }));
}

export function productUpdateLine<K extends keyof ProductLine>(
  userKey: string, lineId: string, field: K, value: ProductLine[K],
): Job | null {
  return withProduct(userKey, p => ({
    ...p,
    lines: p.lines.map(l => l.id === lineId ? { ...l, [field]: value } : l),
  }));
}

export function productUpdateField<K extends keyof ProductDetails>(
  userKey: string, field: K, value: ProductDetails[K],
): Job | null {
  return withProduct(userKey, p => {
    const next = { ...p, [field]: value };
    if (field === 'paymentType' && value !== 'deposit') next.depositAmount = 0;
    return next;
  });
}

/** Live total (inc. GST) for a product sale. */
export function productTotal(p: ProductDetails): number {
  const sum = p.lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0);
  return Math.round(sum * 100) / 100;
}

export type SubmitProductResult =
  | { ok: true; job: Job }
  | { ok: false; error: string; detail?: string };

export function submitProduct(userKey: string): SubmitProductResult {
  const cur = getCurrentJob(userKey);
  if (!cur) return { ok: false, error: 'no_active_job' };
  if (cur.step !== 'product') return { ok: false, error: 'wrong_step' };
  const p = cur.product;
  if (!p) return { ok: false, error: 'no_product_state' };

  const validLines = p.lines.filter(l => l.name.trim().length > 0 && l.qty > 0 && l.unitPrice > 0);
  if (validLines.length === 0) {
    return { ok: false, error: 'no_products', detail: 'Add at least one product with a name, quantity, and price.' };
  }
  if (!p.paymentType) {
    return { ok: false, error: 'missing_payment_type', detail: 'Choose Paying in full or Leaving a deposit.' };
  }
  if (p.paymentType === 'deposit' && (!p.depositAmount || p.depositAmount <= 0)) {
    return { ok: false, error: 'missing_deposit', detail: 'Enter a deposit amount.' };
  }

  const updated = withJob(userKey, c => ({
    ...c,
    step: 'checkout',
    checkout: c.checkout ?? { ...EMPTY_CHECKOUT },
  }));
  if (!updated) return { ok: false, error: 'no_active_job' };
  return { ok: true, job: updated };
}

// ── On-the-spot flow ────────────────────────────────────────────────────────

function withOnTheSpot(userKey: string, fn: (o: OnTheSpotDetails) => OnTheSpotDetails): Job | null {
  return withJob(userKey, cur => cur.onTheSpot ? { ...cur, onTheSpot: fn(cur.onTheSpot) } : cur);
}

export function onTheSpotUpdateField<K extends keyof OnTheSpotDetails>(
  userKey: string, field: K, value: OnTheSpotDetails[K],
): Job | null {
  return withOnTheSpot(userKey, o => {
    const next = { ...o, [field]: value };
    if (field === 'paymentType' && value !== 'deposit') next.depositAmount = 0;
    return next;
  });
}

export type SubmitOnTheSpotResult =
  | { ok: true; job: Job }
  | { ok: false; error: string; detail?: string };

export function submitOnTheSpot(userKey: string): SubmitOnTheSpotResult {
  const cur = getCurrentJob(userKey);
  if (!cur) return { ok: false, error: 'no_active_job' };
  if (cur.step !== 'on_the_spot') return { ok: false, error: 'wrong_step' };
  const o = cur.onTheSpot;
  if (!o) return { ok: false, error: 'no_on_the_spot_state' };

  if (!o.description.trim()) {
    return { ok: false, error: 'missing_description', detail: 'Describe what was fixed.' };
  }
  const total = (Number(o.price) || 0) + (Number(o.hours) || 0) * (Number(o.hourlyRate) || 0);
  if (total <= 0) {
    return { ok: false, error: 'missing_price', detail: 'Enter a price or log hours.' };
  }
  if (!o.paymentType) {
    return { ok: false, error: 'missing_payment_type', detail: 'Choose Paying in full or Leaving a deposit.' };
  }
  if (o.paymentType === 'deposit' && (!o.depositAmount || o.depositAmount <= 0)) {
    return { ok: false, error: 'missing_deposit', detail: 'Enter a deposit amount.' };
  }

  const updated = withJob(userKey, c => ({
    ...c,
    step: 'checkout',
    checkout: c.checkout ?? { ...EMPTY_CHECKOUT },
  }));
  if (!updated) return { ok: false, error: 'no_active_job' };
  return { ok: true, job: updated };
}

// ── Pickup flow ─────────────────────────────────────────────────────────────

function withPickup(userKey: string, fn: (p: PickupDetails) => PickupDetails): Job | null {
  return withJob(userKey, cur => cur.pickup ? { ...cur, pickup: fn(cur.pickup) } : cur);
}

/**
 * Build the pickup screen's data: one group per *active* board entry for
 * this customer, each with its invoices attached.
 *
 * Strategy:
 *   1. Fetch ALL invoices (not just open) for this contact from Xero — a
 *      customer might have already paid for a job and we still want to
 *      show it under its ticket so staff can reprint/review.
 *   2. Find active (not-collected) board entries for this customer via
 *      contactId → phone → email.
 *   3. Distribute each Xero invoice to its matching entry by
 *      entry.invoiceNumbers. Invoices that don't match any entry are
 *      ignored here — they surface via the fallback path only.
 *   4. If no entries match at all, fall back to the flat Xero open-invoice
 *      list (old behaviour). `isFallback` flags this to the UI.
 */
async function pickupLoadInvoices(userKey: string): Promise<void> {
  const initial = getCurrentJob(userKey);
  if (!initial || !initial.pickup) return;
  const cid = initial.contactId;
  if (!cid) {
    withPickup(userKey, p => ({
      ...p,
      loadState: 'error',
      loadError: 'No Xero contact on this job — step 1 must finish first.',
    }));
    return;
  }
  const startedJobId = initial.id;
  try {
    const xero = getXeroClient();
    // Active board entries for this customer — primary source for grouping.
    const entries = boardGetActiveForContact({
      contactId: cid,
      phone: initial.customer.phone,
      email: initial.customer.email,
    });

    let jobGroups: PickupJobGroup[] = [];
    let fallbackInvoices: Invoice[] = [];
    let isFallback = false;

    if (entries.length > 0) {
      // Fetch invoices once, bucket by entry.
      // Using listOpenInvoicesByContact for now — future: add a listAll
      // variant to the Xero client if staff need to see paid invoices
      // too. The grouped UI is otherwise identical.
      const invoices = await xero.listOpenInvoicesByContact(cid);
      jobGroups = entries.map(e => ({
        entryId: e.id,
        jobId: e.jobId,
        displayNumber: e.displayNumber ?? null,
        deviceModel: e.deviceModel || '',
        deviceEmoji: e.deviceEmoji || '',
        status: e.status,
        createdAt: e.createdAt,
        updatedAt: e.updatedAt,
        invoices: invoicesForEntry(e, invoices),
      }));
    } else {
      // No active board entries — fall back to the flat Xero list so the
      // screen still works for pre-board jobs / externally-created invoices.
      fallbackInvoices = await xero.listOpenInvoicesByContact(cid);
      isFallback = true;
    }

    const hasContent = jobGroups.length > 0 || fallbackInvoices.length > 0;

    // Guard against job being cleared or replaced while we were awaiting.
    const now = getCurrentJob(userKey);
    if (!now || now.id !== startedJobId || !now.pickup) return;
    withPickup(userKey, p => ({
      ...p,
      loadState: hasContent ? 'loaded' : 'empty',
      loadError: null,
      jobGroups,
      invoices: fallbackInvoices,
      isFallback,
      // Clear any prior selection — the job list may have reshaped.
      selectedInvoiceId: null,
      selectedEntryId: null,
    }));
  } catch (err) {
    const now = getCurrentJob(userKey);
    if (!now || now.id !== startedJobId || !now.pickup) return;
    withPickup(userKey, p => ({
      ...p,
      loadState: 'error',
      loadError: err instanceof Error ? err.message : String(err),
    }));
  }
}

/**
 * Filter a list of Xero invoices down to the ones attached to a specific
 * BoardEntry. We match on invoice *number* (human-readable) rather than
 * invoiceId because that's what gets stored on the entry at checkout.
 */
function invoicesForEntry(entry: BoardEntry, all: Invoice[]): Invoice[] {
  const attached = new Set((entry.invoiceNumbers || []).map(n => n.trim()).filter(Boolean));
  if (attached.size === 0) return [];
  return all.filter(inv => attached.has(inv.invoiceNumber));
}

/**
 * Dev-only: creates a fake invoice for the current job's Xero contact, then
 * reloads the list. Lets us exercise the pickup UI before the real checkout
 * flow is creating invoices. Remove once checkout is wired up.
 */
export function pickupSeedTestInvoice(userKey: string): Job | null {
  const cur = getCurrentJob(userKey);
  if (!cur || !cur.pickup || !cur.contactId) return cur;
  seedPickupTestInvoice(cur.contactId);
  return pickupReload(userKey);
}

export function pickupReload(userKey: string): Job | null {
  const updated = withJob(userKey, cur =>
    cur.pickup ? { ...cur, pickup: { ...cur.pickup, loadState: 'loading', loadError: null } } : cur,
  );
  if (updated?.pickup) void pickupLoadInvoices(userKey);
  return updated;
}

/**
 * Look up an invoice across both the grouped job list and the flat
 * fallback list, returning the (invoice, owning entryId) tuple.
 * entryId is null when the match came from the fallback bucket.
 *
 * Exported so receipt-pdf.ts and other downstream consumers don't have
 * to re-implement the two-source lookup — there are several places that
 * resolve the selected invoice and we want them in lockstep.
 */
export function findPickupInvoice(
  p: PickupDetails,
  invoiceId: string,
): { invoice: Invoice; entryId: string | null } | null {
  for (const g of p.jobGroups) {
    const hit = g.invoices.find(i => i.invoiceId === invoiceId);
    if (hit) return { invoice: hit, entryId: g.entryId };
  }
  const flat = p.invoices.find(i => i.invoiceId === invoiceId);
  if (flat) return { invoice: flat, entryId: null };
  return null;
}

/** Shortcut for "the currently-selected invoice, wherever it lives". */
export function selectedPickupInvoice(p: PickupDetails): Invoice | null {
  if (!p.selectedInvoiceId) return null;
  return findPickupInvoice(p, p.selectedInvoiceId)?.invoice ?? null;
}

export function pickupSelectInvoice(userKey: string, invoiceId: string): Job | null {
  return withPickup(userKey, p => {
    const found = findPickupInvoice(p, invoiceId);
    if (!found) return p;
    return { ...p, selectedInvoiceId: invoiceId, selectedEntryId: found.entryId };
  });
}

export function pickupClearSelection(userKey: string): Job | null {
  return withPickup(userKey, p => ({
    ...p,
    selectedInvoiceId: null,
    selectedEntryId: null,
    extraLines: [],
    extraNotes: '',
  }));
}

function newPickupExtraLine(): PickupExtraLine {
  return { id: shortId(), description: '', amount: 0 };
}

export function pickupAddExtraLine(userKey: string): Job | null {
  return withPickup(userKey, p => ({ ...p, extraLines: [...p.extraLines, newPickupExtraLine()] }));
}

export function pickupRemoveExtraLine(userKey: string, lineId: string): Job | null {
  return withPickup(userKey, p => ({ ...p, extraLines: p.extraLines.filter(l => l.id !== lineId) }));
}

export function pickupUpdateExtraLine<K extends 'description' | 'amount'>(
  userKey: string, lineId: string, field: K, value: PickupExtraLine[K],
): Job | null {
  return withPickup(userKey, p => ({
    ...p,
    extraLines: p.extraLines.map(l => l.id === lineId ? { ...l, [field]: value } : l),
  }));
}

export function pickupUpdateField<K extends 'extraNotes'>(
  userKey: string, field: K, value: PickupDetails[K],
): Job | null {
  return withPickup(userKey, p => ({ ...p, [field]: value }));
}

export type SubmitPickupResult =
  | { ok: true; job: Job }
  | { ok: false; error: string; detail?: string };

export function submitPickup(userKey: string): SubmitPickupResult {
  const cur = getCurrentJob(userKey);
  if (!cur) return { ok: false, error: 'no_active_job' };
  if (cur.step !== 'pickup') return { ok: false, error: 'wrong_step' };
  const pu = cur.pickup;
  if (!pu) return { ok: false, error: 'no_pickup_state' };

  if (!pu.selectedInvoiceId) {
    return { ok: false, error: 'missing_invoice', detail: 'Pick which invoice the customer is collecting.' };
  }
  // Look up in both the grouped list and the fallback flat list — either
  // is a valid source depending on whether the customer has active jobs.
  if (!findPickupInvoice(pu, pu.selectedInvoiceId)) {
    return { ok: false, error: 'invalid_invoice', detail: 'That invoice is no longer in the open list.' };
  }
  for (const l of pu.extraLines) {
    if (!l.description.trim() || l.amount <= 0) {
      return { ok: false, error: 'invalid_extra_line', detail: 'Each extra charge needs a description and amount.' };
    }
  }

  const updated = withJob(userKey, c => ({
    ...c,
    step: 'checkout',
    checkout: c.checkout ?? { ...EMPTY_CHECKOUT },
  }));
  if (!updated) return { ok: false, error: 'no_active_job' };
  return { ok: true, job: updated };
}

// ── Checkout flow ───────────────────────────────────────────────────────────

function withCheckout(userKey: string, fn: (c: CheckoutDetails) => CheckoutDetails): Job | null {
  return withJob(userKey, cur => cur.checkout ? { ...cur, checkout: fn(cur.checkout) } : cur);
}

/** How much to charge/record today, based on which flow originated this checkout. */
export function amountDueToday(job: Job): { amount: number; isDeposit: boolean } {
  const r = job.repair;
  const p = job.product;
  const o = job.onTheSpot;
  const pu = job.pickup;
  if (r) {
    const total = repairTotal(r);
    const isDeposit = r.paymentType === 'deposit';
    return { amount: isDeposit ? (Number(r.depositAmount) || 0) : total, isDeposit };
  }
  if (p) {
    const total = productTotal(p);
    const isDeposit = p.paymentType === 'deposit';
    return { amount: isDeposit ? (Number(p.depositAmount) || 0) : total, isDeposit };
  }
  if (o) {
    const total = (Number(o.price) || 0) + (Number(o.hours) || 0) * (Number(o.hourlyRate) || 0);
    const isDeposit = o.paymentType === 'deposit';
    return { amount: isDeposit ? (Number(o.depositAmount) || 0) : total, isDeposit };
  }
  if (pu) {
    const inv = selectedPickupInvoice(pu);
    const invDue = Number(inv?.amountDue) || 0;
    const extras = pu.extraLines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
    return { amount: invDue + extras, isDeposit: false };
  }
  return { amount: 0, isDeposit: false };
}

export function checkoutPickMethod(userKey: string, method: PaymentMethod): Job | null {
  return withCheckout(userKey, c => {
    // Only valid from choosing or card_declined.
    if (c.state !== 'choosing' && c.state !== 'card_declined') return c;
    if (method === 'cash') return { ...c, method, state: 'cash_entry', declineReason: null };
    if (method === 'pay_later') return { ...c, method, state: 'processing', declineReason: null };
    // card — caller will drive the charge via a separate message
    return { ...c, method, state: 'card_charging', declineReason: null };
  });
}

export function checkoutUpdateTendered(userKey: string, amount: number): Job | null {
  return withCheckout(userKey, c => ({ ...c, cashTendered: amount }));
}

export function checkoutResetMethod(userKey: string): Job | null {
  return withCheckout(userKey, c => ({
    ...c,
    state: 'choosing',
    method: null,
    cashTendered: 0,
    declineReason: null,
    error: null,
  }));
}

/** Build line items for the originating flow. Used for new-invoice creation. */
function lineItemsForFlow(job: Job): { lines: LineItem[]; reference: string } {
  const r = job.repair;
  const p = job.product;
  const o = job.onTheSpot;
  if (r) {
    const lines: LineItem[] = r.lines
      .filter(l => l.service)
      .map(l => ({
        description: l.service + (l.variant ? ` — ${l.variant}` : ''),
        quantity: 1,
        unitPriceIncGst: Number(l.cost) || 0,
      }));
    if (r.customServiceName.trim() && (Number(r.customServiceAmount) || 0) > 0) {
      lines.push({ description: r.customServiceName.trim(), quantity: 1, unitPriceIncGst: Number(r.customServiceAmount) || 0 });
    }
    return { lines, reference: r.jobDescription ? r.jobDescription.slice(0, 100) : 'Repair' };
  }
  if (p) {
    const lines: LineItem[] = p.lines
      .filter(l => l.name.trim())
      .map(l => ({
        description: l.name.trim(),
        quantity: Number(l.qty) || 1,
        unitPriceIncGst: Number(l.unitPrice) || 0,
      }));
    return { lines, reference: p.notes ? p.notes.slice(0, 100) : 'Product sale' };
  }
  if (o) {
    const lines: LineItem[] = [];
    if ((Number(o.price) || 0) > 0) {
      lines.push({ description: o.description || 'Quick fix', quantity: 1, unitPriceIncGst: Number(o.price) || 0 });
    }
    if ((Number(o.hours) || 0) > 0) {
      lines.push({
        description: `Labour — ${o.hours} hr${o.hours === 1 ? '' : 's'} @ $${(Number(o.hourlyRate) || 0).toFixed(2)}/hr`,
        quantity: Number(o.hours) || 0,
        unitPriceIncGst: Number(o.hourlyRate) || 0,
      });
    }
    return { lines, reference: o.notes ? o.notes.slice(0, 100) : 'On-the-spot' };
  }
  return { lines: [], reference: '' };
}

/** The big one: create invoices + payments + board entry + emails based on
 *  flow + method. Non-critical failures (email) don't abort — they're
 *  logged in the receipt so staff can retry manually. */
export async function checkoutConfirm(userKey: string): Promise<Job | null> {
  const initial = getCurrentJob(userKey);
  if (!initial || initial.step !== 'checkout') return initial;
  const c = initial.checkout;
  if (!c || !c.method) return initial;
  if (c.state !== 'processing' && c.state !== 'cash_entry' && c.state !== 'card_charging') {
    return initial; // only run if we're at a confirmable state
  }

  const method = c.method;
  const job = initial;
  const { amount: amountDueTodayValue } = amountDueToday(job);

  // Guard: cash requires tendered >= due
  if (method === 'cash' && c.cashTendered < amountDueTodayValue) {
    return withCheckout(userKey, cur => ({ ...cur, state: 'error', error: 'Cash tendered is less than amount due.' }));
  }

  withCheckout(userKey, cur => ({ ...cur, state: 'processing', error: null }));

  const xero = getXeroClient();
  const email = getEmailClient();

  const invoiceNumbers: string[] = [];
  const pdfAttachments: { filename: string; data: Buffer }[] = [];

  try {
    // ─── Xero: create invoice(s) + payment(s) ─────────────────────────────
    if (job.pickup) {
      const pu = job.pickup;
      const selected = selectedPickupInvoice(pu);
      if (!selected) throw new Error('Selected pickup invoice is missing.');

      // Main invoice — record payment unless pay_later
      invoiceNumbers.push(selected.invoiceNumber);
      if (method !== 'pay_later' && (Number(selected.amountDue) || 0) > 0) {
        await xero.createPayment({
          invoiceId: selected.invoiceId,
          amount: Number(selected.amountDue) || 0,
          reference: method === 'cash' ? 'Cash at pickup' : 'Card at pickup',
        });
      }
      pdfAttachments.push({ filename: `${selected.invoiceNumber}.pdf`, data: await xero.getInvoicePdf(selected.invoiceId) });

      // Extras → second invoice
      if (pu.extraLines.length > 0) {
        const extraLines: LineItem[] = pu.extraLines.map(l => ({
          description: l.description.trim(),
          quantity: 1,
          unitPriceIncGst: Number(l.amount) || 0,
        }));
        const extraInv = await xero.createInvoice({
          contactId: job.contactId!,
          lineItems: extraLines,
          reference: `Additional charges for ${selected.invoiceNumber}`,
        });
        invoiceNumbers.push(extraInv.invoiceNumber);
        if (method !== 'pay_later' && extraInv.totalIncGst > 0) {
          await xero.createPayment({
            invoiceId: extraInv.invoiceId,
            amount: extraInv.totalIncGst,
            reference: method === 'cash' ? 'Cash at pickup' : 'Card at pickup',
          });
        }
        pdfAttachments.push({ filename: `${extraInv.invoiceNumber}.pdf`, data: await xero.getInvoicePdf(extraInv.invoiceId) });
      }
    } else {
      // Repair / Product / On-the-spot: create a fresh invoice, then pay (unless pay_later).
      const { lines, reference } = lineItemsForFlow(job);
      if (lines.length === 0) throw new Error('Nothing to invoice — no line items.');
      if (!job.contactId) throw new Error('No Xero contact on job — step 1 did not complete.');
      const invoice = await xero.createInvoice({ contactId: job.contactId, lineItems: lines, reference });
      invoiceNumbers.push(invoice.invoiceNumber);

      if (method !== 'pay_later' && amountDueTodayValue > 0) {
        await xero.createPayment({
          invoiceId: invoice.invoiceId,
          amount: amountDueTodayValue,
          reference: method === 'cash' ? 'Cash at counter' : 'Card at counter',
        });
      }
      pdfAttachments.push({ filename: `${invoice.invoiceNumber}.pdf`, data: await xero.getInvoicePdf(invoice.invoiceId) });
    }

    // ─── Job Board: create/update card. Non-critical — log-only on failure. ─
    // Repair/product/on-the-spot create a new card; pickup finds the most
    // recent open card for this contact and moves it to done_collected
    // (falling back to a fresh card if none exists).
    try {
      const flow: BoardFlow = job.pickup
        ? 'pickup'
        : job.onTheSpot
        ? 'on_the_spot'
        : job.product
        ? 'product'
        : 'repair';
      const deviceModel = job.repair?.deviceModel || '';
      const jobDescription = job.repair?.jobDescription
        || job.product?.notes
        || job.onTheSpot?.description
        || job.pickup?.extraNotes
        || '';
      const amountPaid = method === 'pay_later' ? 0 : amountDueTodayValue;
      const createInput = {
        jobId: job.id,
        displayNumber: job.displayNumber,
        customerName: `${job.customer.firstName} ${job.customer.lastName}`.trim(),
        customerEmail: job.customer.email,
        customerPhone: job.customer.phone,
        contactId: job.contactId,
        deviceModel,
        deviceIntent: job.customer.deviceIntent,
        flow,
        jobDescription,
        invoiceNumbers,
        amountDueToday: amountDueTodayValue,
        amountPaid,
        paymentMethod: method,
        // Pass through the encrypted-password record id so the job card can
        // show a "Reveal password" button for the 30-day retention window.
        passwordRecordId: job.passwordRecordId,
        createdBy: job.startedBy,
      };
      const boardEntry = flow === 'pickup'
        ? await boardCompleteForPickup(job.contactId, createInput)
        : await boardCreateEntry(createInput);

      // ─── Attachments: receipt PDF + one PDF per invoice. ────────────────
      // Saved to the board entry so staff can re-download or view the
      // receipt and invoices later from the job card drawer. Non-critical —
      // if any of these fail, the checkout still succeeds and the email
      // attachments still go out.
      try {
        const cashTendered = method === 'cash' ? c.cashTendered : undefined;
        const changeGiven = method === 'cash'
          ? Math.max(0, c.cashTendered - amountDueTodayValue)
          : undefined;
        const receiptPdf = await generateReceiptPdf({
          job,
          invoiceNumbers,
          method,
          amountDueToday: amountDueTodayValue,
          amountPaid: method === 'pay_later' ? 0 : amountDueTodayValue,
          cashTendered,
          changeGiven,
        });
        const serviceLabel = job.displayNumber ? `#${job.displayNumber}` : job.id;
        await boardAddAttachment(boardEntry.id, {
          kind: 'receipt',
          name: `Receipt — Job ${serviceLabel}`,
          filename: `receipt-${job.displayNumber ?? job.id}.pdf`,
          data: receiptPdf,
        });
        for (const inv of pdfAttachments) {
          const invNum = inv.filename.replace(/\.pdf$/i, '');
          await boardAddAttachment(boardEntry.id, {
            kind: 'invoice',
            name: `Invoice ${invNum}`,
            filename: inv.filename,
            data: inv.data,
          });
        }
      } catch (err) {
        console.warn('[checkout] Attachment step failed, continuing:', err);
      }
    } catch (err) {
      console.warn('[checkout] Job Board step failed, continuing:', err);
    }

    // ─── Email: receipt / invoice. Non-critical. ──────────────────────────
    let reviewEmailScheduledAt: string | undefined;
    if (job.customer.email) {
      try {
        const subject = method === 'pay_later'
          ? `Your invoice from Computer Mechanics — ${invoiceNumbers.join(', ')}`
          : `Receipt from Computer Mechanics — ${invoiceNumbers.join(', ')}`;
        const body = method === 'pay_later'
          ? `<p>Hi ${job.customer.firstName || ''},</p><p>Your invoice is attached. Please pay at your convenience — see invoice for details.</p><p>— Computer Mechanics</p>`
          : `<p>Hi ${job.customer.firstName || ''},</p><p>Thanks for choosing Computer Mechanics. Your receipt is attached.</p><p>— Computer Mechanics</p>`;
        await email.send({
          to: job.customer.email,
          subject,
          bodyHtml: body,
          attachments: pdfAttachments.map(a => ({ filename: a.filename, data: a.data, contentType: 'application/pdf' })),
        });

        // Google review — 30 min delay, pickup flow only, and only if they paid.
        if (job.pickup && method !== 'pay_later') {
          const delayMs = 30 * 60 * 1000;
          const scheduled = await email.sendDelayed({
            to: job.customer.email,
            subject: 'How did we do? — Computer Mechanics',
            bodyHtml: `<p>Hi ${job.customer.firstName || ''},</p><p>Thanks again for choosing Computer Mechanics. If you have a moment, we'd love a quick Google review: <a href="https://g.page/r/computer-mechanics/review">leave a review</a>.</p>`,
            delayMs,
          });
          reviewEmailScheduledAt = scheduled.sendAt;
        }
      } catch (err) {
        console.warn('[checkout] Email step failed, continuing:', err);
      }
    }

    // ─── Success — populate receipt ───────────────────────────────────────
    const receipt: CheckoutReceipt = {
      method,
      amountDueToday: amountDueTodayValue,
      amountPaid: method === 'pay_later' ? 0 : amountDueTodayValue,
      invoiceNumbers,
      cashTendered: method === 'cash' ? c.cashTendered : undefined,
      changeGiven: method === 'cash' ? Math.max(0, c.cashTendered - amountDueTodayValue) : undefined,
      reviewEmailScheduledAt,
    };
    return withCheckout(userKey, cur => ({ ...cur, state: 'done', receipt, error: null }));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return withCheckout(userKey, cur => ({ ...cur, state: 'error', error: msg }));
  }
}

/** After Tyro declines. UI calls this to show the decline panel with retry/switch options. */
export function checkoutCardDeclined(userKey: string, reason: string): Job | null {
  return withCheckout(userKey, c => ({ ...c, state: 'card_declined', declineReason: reason }));
}

/** Called by the card flow — runs tyro.charge, then (on approval) calls confirm. */
export async function checkoutChargeCard(userKey: string): Promise<Job | null> {
  const cur = getCurrentJob(userKey);
  if (!cur || !cur.checkout) return cur;
  const c = cur.checkout;
  if (c.method !== 'card' || c.state !== 'card_charging') return cur;

  const { amount } = amountDueToday(cur);
  if (amount <= 0) {
    // Nothing to charge — treat as pay_later (e.g. $0 due)
    return checkoutConfirm(userKey);
  }

  const tyro = getTyroClient();
  try {
    const result = await tyro.charge({ amount, reference: `Job ${cur.id}` });
    if (!result.approved) {
      return checkoutCardDeclined(userKey, result.declineReason || 'Declined by terminal.');
    }
    // Stash the card result for the receipt before running confirm.
    withCheckout(userKey, c2 => ({
      ...c2,
      state: 'processing',
      receipt: {
        method: 'card',
        amountDueToday: amount,
        amountPaid: amount,
        invoiceNumbers: [],
        cardType: result.cardType,
        cardLastFour: result.cardLastFour,
        transactionRef: result.transactionRef,
      },
    }));
    const after = await checkoutConfirm(userKey);
    // Fold card details back into the final receipt (confirm replaced it).
    if (after?.checkout?.receipt && (result.cardType || result.cardLastFour)) {
      return withCheckout(userKey, c2 => ({
        ...c2,
        receipt: c2.receipt
          ? { ...c2.receipt, cardType: result.cardType, cardLastFour: result.cardLastFour, transactionRef: result.transactionRef }
          : c2.receipt,
      }));
    }
    return after;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return checkoutCardDeclined(userKey, msg);
  }
}

export function toCustomerFacing(job: Job | null): CustomerFacingJob | null {
  if (!job) return null;
  const { computerPassword: _pwd, ...rest } = job.customer;
  const { startedBy: _sb, customer: _c, ...jobRest } = job;
  return { ...jobRest, customer: rest };
}
