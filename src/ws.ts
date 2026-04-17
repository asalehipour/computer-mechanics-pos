/**
 * WebSocket plumbing for the dual-screen sync.
 *
 * Each connection identifies itself as `staff` or `customer`. The full job
 * state is broadcast to staff connections; a redacted (customer-safe) view
 * goes to customer connections.
 */

import type { FastifyInstance } from 'fastify';
import fastifyWebsocket from '@fastify/websocket';
import { requireAuth, type SessionUser } from './auth.js';
import {
  addComment as boardAddComment,
  addPart as boardAddPart,
  deleteComment as boardDeleteComment,
  deleteEntry as boardDeleteEntry,
  editComment as boardEditComment,
  getAllEntriesSync as boardGetAllSync,
  isBoardStatus,
  moveEntry as boardMoveEntry,
  onBoardChange,
  removePart as boardRemovePart,
  updateEntry as boardUpdateEntry,
  type BoardEntry,
  type EditableEntryField,
} from './job-board.js';
import {
  getCurrentJob,
  isCustomerField,
  isDeviceIntent,
  isRepairField,
  isRepairLineField,
  isProductField,
  isProductLineField,
  isOnTheSpotField,
  isRoute,
  onJobChange,
  startNewJob,
  submitStep1,
  submitRepair,
  submitProduct,
  submitOnTheSpot,
  toCustomerFacing,
  updateCustomerField,
  clearJob,
  chooseRoute,
  backToRouter,
  backFromCheckout,
  repairAddLine,
  repairRemoveLine,
  repairUpdateLine,
  repairUpdateField,
  productAddLine,
  productRemoveLine,
  productUpdateLine,
  productUpdateField,
  onTheSpotUpdateField,
  isPickupField,
  isPickupLineField,
  pickupReload,
  pickupSeedTestInvoice,
  pickupSelectInvoice,
  pickupClearSelection,
  pickupAddExtraLine,
  pickupRemoveExtraLine,
  pickupUpdateExtraLine,
  pickupUpdateField,
  submitPickup,
  checkoutPickMethod,
  checkoutUpdateTendered,
  checkoutResetMethod,
  checkoutConfirm,
  checkoutChargeCard,
  isSignatureKind,
  requestSignature,
  cancelSignatureRequest,
  submitSignature,
  clearSignature,
  type CustomerDetails,
  type RepairDetails,
  type ServiceLine,
  type ProductDetails,
  type ProductLine,
  type OnTheSpotDetails,
  type PaymentMethod,
} from './job.js';

type Audience = 'staff' | 'customer';

interface Conn {
  socket: WebSocket;
  audience: Audience;
}

const connections = new Set<Conn>();

function sendState(conn: Conn) {
  const job = getCurrentJob();
  const payload = conn.audience === 'customer' ? toCustomerFacing(job) : job;
  try {
    conn.socket.send(JSON.stringify({ type: 'state', job: payload }));
  } catch {
    /* socket might already be closed */
  }
}

function broadcast() {
  for (const c of connections) sendState(c);
}

function sendBoardState(conn: Conn, entries: BoardEntry[]) {
  if (conn.audience !== 'staff') return;
  try {
    conn.socket.send(JSON.stringify({ type: 'boardState', entries }));
  } catch { /* socket closed */ }
}

function broadcastBoard(entries: BoardEntry[]) {
  for (const c of connections) sendBoardState(c, entries);
}

// Re-broadcast whenever the job changes
onJobChange(() => broadcast());
// Re-broadcast the board whenever entries change
onBoardChange((entries) => broadcastBoard(entries));

interface IncomingMessage {
  type: string;
  audience?: Audience;
  field?: string;
  value?: unknown;
  route?: unknown;
  lineId?: string;
  invoiceId?: string;
  method?: unknown;
  kind?: unknown;
  dataUrl?: unknown;
  entryId?: string;
  status?: unknown;
  body?: unknown;
  name?: unknown;
  url?: unknown;
  partId?: string;
  commentId?: string;
}

function isPaymentMethod(x: unknown): x is PaymentMethod {
  return x === 'cash' || x === 'card' || x === 'pay_later';
}

export async function registerWebSocket(app: FastifyInstance) {
  await app.register(fastifyWebsocket);

  app.get('/ws', { websocket: true, preHandler: requireAuth }, (socket, req) => {
    const user = req.session.get('user') as SessionUser | undefined;
    const conn: Conn = { socket: socket as unknown as WebSocket, audience: 'staff' };
    connections.add(conn);

    // Send current state immediately on connect (even before subscribe, so
    // staff reloading doesn't see a flash of empty)
    sendState(conn);
    // Board is staff-only; the audience starts as 'staff' by default so this
    // is safe, and subscribe→customer will just ignore later board broadcasts.
    sendBoardState(conn, boardGetAllSync());

    socket.on('message', async (raw: Buffer) => {
      let msg: IncomingMessage;
      try { msg = JSON.parse(raw.toString()); }
      catch { return; }

      switch (msg.type) {
        case 'subscribe': {
          if (msg.audience === 'customer' || msg.audience === 'staff') {
            conn.audience = msg.audience;
            sendState(conn);
            sendBoardState(conn, boardGetAllSync());
          }
          break;
        }
        case 'newJob': {
          if (conn.audience !== 'staff' || !user) return;
          startNewJob({ name: user.name, email: user.email });
          break;
        }
        case 'clearJob': {
          if (conn.audience !== 'staff') return;
          clearJob();
          break;
        }
        case 'updateField': {
          if (conn.audience !== 'staff') return;
          if (typeof msg.field !== 'string' || !isCustomerField(msg.field)) return;
          const v = msg.value;
          if (msg.field === 'hasComputerPassword') {
            updateCustomerField('hasComputerPassword', Boolean(v));
          } else if (msg.field === 'deviceIntent') {
            // Null clears the answer; otherwise must be a valid intent.
            if (v === null) updateCustomerField('deviceIntent', null);
            else if (isDeviceIntent(v)) updateCustomerField('deviceIntent', v);
          } else {
            updateCustomerField(msg.field as Exclude<keyof CustomerDetails, 'hasComputerPassword' | 'deviceIntent'>, String(v ?? ''));
          }
          break;
        }
        case 'submitStep1': {
          if (conn.audience !== 'staff') return;
          const result = await submitStep1();
          try {
            conn.socket.send(JSON.stringify({ type: 'step1Result', result }));
          } catch { /* ignore */ }
          break;
        }
        case 'chooseRoute': {
          if (conn.audience !== 'staff') return;
          if (!isRoute(msg.route)) return;
          chooseRoute(msg.route);
          break;
        }
        case 'backToRouter': {
          if (conn.audience !== 'staff') return;
          backToRouter();
          break;
        }
        case 'backFromCheckout': {
          if (conn.audience !== 'staff') return;
          backFromCheckout();
          break;
        }
        case 'repairAddLine': {
          if (conn.audience !== 'staff') return;
          repairAddLine();
          break;
        }
        case 'repairRemoveLine': {
          if (conn.audience !== 'staff') return;
          if (typeof msg.lineId !== 'string') return;
          repairRemoveLine(msg.lineId);
          break;
        }
        case 'repairUpdateLine': {
          if (conn.audience !== 'staff') return;
          if (typeof msg.lineId !== 'string') return;
          if (typeof msg.field !== 'string' || !isRepairLineField(msg.field)) return;
          const v = msg.value;
          if (msg.field === 'cost') {
            repairUpdateLine(msg.lineId, 'cost', Number(v) || 0);
          } else {
            repairUpdateLine(msg.lineId, msg.field as Exclude<keyof ServiceLine, 'cost' | 'id'>, String(v ?? ''));
          }
          break;
        }
        case 'repairUpdateField': {
          if (conn.audience !== 'staff') return;
          if (typeof msg.field !== 'string' || !isRepairField(msg.field)) return;
          const v = msg.value;
          switch (msg.field) {
            case 'customServiceAmount':
            case 'depositAmount':
              repairUpdateField(msg.field, Number(v) || 0);
              break;
            case 'paymentType':
              if (v === 'full' || v === 'deposit' || v === null) {
                repairUpdateField('paymentType', v as RepairDetails['paymentType']);
              }
              break;
            case 'deviceModel':
            case 'jobDescription':
            case 'customServiceName':
              repairUpdateField(msg.field, String(v ?? ''));
              break;
          }
          break;
        }
        case 'submitRepair': {
          if (conn.audience !== 'staff') return;
          const result = submitRepair();
          try {
            conn.socket.send(JSON.stringify({ type: 'repairResult', result }));
          } catch { /* ignore */ }
          break;
        }
        case 'productAddLine': {
          if (conn.audience !== 'staff') return;
          productAddLine();
          break;
        }
        case 'productRemoveLine': {
          if (conn.audience !== 'staff') return;
          if (typeof msg.lineId !== 'string') return;
          productRemoveLine(msg.lineId);
          break;
        }
        case 'productUpdateLine': {
          if (conn.audience !== 'staff') return;
          if (typeof msg.lineId !== 'string') return;
          if (typeof msg.field !== 'string' || !isProductLineField(msg.field)) return;
          const v = msg.value;
          if (msg.field === 'qty' || msg.field === 'unitPrice') {
            productUpdateLine(msg.lineId, msg.field, Number(v) || 0);
          } else {
            productUpdateLine(msg.lineId, 'name', String(v ?? ''));
          }
          break;
        }
        case 'productUpdateField': {
          if (conn.audience !== 'staff') return;
          if (typeof msg.field !== 'string' || !isProductField(msg.field)) return;
          const v = msg.value;
          switch (msg.field) {
            case 'depositAmount':
              productUpdateField('depositAmount', Number(v) || 0);
              break;
            case 'paymentType':
              if (v === 'full' || v === 'deposit' || v === null) {
                productUpdateField('paymentType', v as ProductDetails['paymentType']);
              }
              break;
            case 'notes':
              productUpdateField('notes', String(v ?? ''));
              break;
          }
          break;
        }
        case 'submitProduct': {
          if (conn.audience !== 'staff') return;
          const result = submitProduct();
          try {
            conn.socket.send(JSON.stringify({ type: 'productResult', result }));
          } catch { /* ignore */ }
          break;
        }
        case 'onTheSpotUpdateField': {
          if (conn.audience !== 'staff') return;
          if (typeof msg.field !== 'string' || !isOnTheSpotField(msg.field)) return;
          const v = msg.value;
          switch (msg.field) {
            case 'price':
            case 'depositAmount':
            case 'hours':
            case 'hourlyRate':
              onTheSpotUpdateField(msg.field, Number(v) || 0);
              break;
            case 'paymentType':
              if (v === 'full' || v === 'deposit' || v === null) {
                onTheSpotUpdateField('paymentType', v as OnTheSpotDetails['paymentType']);
              }
              break;
            case 'description':
            case 'notes':
              onTheSpotUpdateField(msg.field, String(v ?? ''));
              break;
          }
          break;
        }
        case 'submitOnTheSpot': {
          if (conn.audience !== 'staff') return;
          const result = submitOnTheSpot();
          try {
            conn.socket.send(JSON.stringify({ type: 'onTheSpotResult', result }));
          } catch { /* ignore */ }
          break;
        }
        case 'pickupReload': {
          if (conn.audience !== 'staff') return;
          pickupReload();
          break;
        }
        case 'pickupSeedTestInvoice': {
          // Dev-only helper. Remove when checkout creates real invoices.
          if (conn.audience !== 'staff') return;
          pickupSeedTestInvoice();
          break;
        }
        case 'pickupSelectInvoice': {
          if (conn.audience !== 'staff') return;
          if (typeof msg.invoiceId !== 'string') return;
          pickupSelectInvoice(msg.invoiceId);
          break;
        }
        case 'pickupClearSelection': {
          if (conn.audience !== 'staff') return;
          pickupClearSelection();
          break;
        }
        case 'pickupAddExtraLine': {
          if (conn.audience !== 'staff') return;
          pickupAddExtraLine();
          break;
        }
        case 'pickupRemoveExtraLine': {
          if (conn.audience !== 'staff') return;
          if (typeof msg.lineId !== 'string') return;
          pickupRemoveExtraLine(msg.lineId);
          break;
        }
        case 'pickupUpdateExtraLine': {
          if (conn.audience !== 'staff') return;
          if (typeof msg.lineId !== 'string') return;
          if (typeof msg.field !== 'string' || !isPickupLineField(msg.field)) return;
          const v = msg.value;
          if (msg.field === 'amount') {
            pickupUpdateExtraLine(msg.lineId, 'amount', Number(v) || 0);
          } else {
            pickupUpdateExtraLine(msg.lineId, 'description', String(v ?? ''));
          }
          break;
        }
        case 'pickupUpdateField': {
          if (conn.audience !== 'staff') return;
          if (typeof msg.field !== 'string' || !isPickupField(msg.field)) return;
          pickupUpdateField('extraNotes', String(msg.value ?? ''));
          break;
        }
        case 'submitPickup': {
          if (conn.audience !== 'staff') return;
          const result = submitPickup();
          try {
            conn.socket.send(JSON.stringify({ type: 'pickupResult', result }));
          } catch { /* ignore */ }
          break;
        }
        case 'checkoutPickMethod': {
          if (conn.audience !== 'staff') return;
          if (!isPaymentMethod(msg.method)) return;
          checkoutPickMethod(msg.method);
          // 'pay_later' moves the state straight to 'processing'; run confirm.
          if (msg.method === 'pay_later') {
            void checkoutConfirm();
          }
          break;
        }
        case 'checkoutUpdateTendered': {
          if (conn.audience !== 'staff') return;
          checkoutUpdateTendered(Number(msg.value) || 0);
          break;
        }
        case 'checkoutConfirmCash': {
          if (conn.audience !== 'staff') return;
          void checkoutConfirm();
          break;
        }
        case 'checkoutChargeCard': {
          if (conn.audience !== 'staff') return;
          void checkoutChargeCard();
          break;
        }
        case 'checkoutResetMethod': {
          if (conn.audience !== 'staff') return;
          checkoutResetMethod();
          break;
        }
        case 'requestSignature': {
          if (conn.audience !== 'staff') return;
          if (!isSignatureKind(msg.kind)) return;
          requestSignature(msg.kind);
          break;
        }
        case 'cancelSignatureRequest': {
          if (conn.audience !== 'staff') return;
          cancelSignatureRequest();
          break;
        }
        case 'clearSignature': {
          if (conn.audience !== 'staff') return;
          if (!isSignatureKind(msg.kind)) return;
          clearSignature(msg.kind);
          break;
        }
        case 'submitSignature': {
          // Only valid from the customer audience, and only if there's a
          // matching pending request (staff must have asked first).
          if (conn.audience !== 'customer') return;
          if (!isSignatureKind(msg.kind)) return;
          if (typeof msg.dataUrl !== 'string') return;
          const job = getCurrentJob();
          if (!job?.signatureRequest || job.signatureRequest.kind !== msg.kind) return;
          submitSignature(msg.kind, msg.dataUrl);
          break;
        }
        // ── Job Board (staff-only) ──────────────────────────────────────
        case 'boardMove': {
          if (conn.audience !== 'staff') return;
          if (typeof msg.entryId !== 'string') return;
          if (!isBoardStatus(msg.status)) return;
          void boardMoveEntry(msg.entryId, msg.status);
          break;
        }
        case 'boardAddComment': {
          if (conn.audience !== 'staff' || !user) return;
          if (typeof msg.entryId !== 'string') return;
          if (typeof msg.body !== 'string') return;
          void boardAddComment(msg.entryId, { name: user.name, email: user.email }, msg.body);
          break;
        }
        case 'boardDeleteEntry': {
          if (conn.audience !== 'staff') return;
          if (typeof msg.entryId !== 'string') return;
          void boardDeleteEntry(msg.entryId);
          break;
        }
        case 'boardRefresh': {
          if (conn.audience !== 'staff') return;
          sendBoardState(conn, boardGetAllSync());
          break;
        }
        case 'boardAddPart': {
          if (conn.audience !== 'staff' || !user) return;
          if (typeof msg.entryId !== 'string') return;
          if (typeof msg.name !== 'string' || typeof msg.url !== 'string') return;
          void boardAddPart(msg.entryId, { name: user.name, email: user.email }, msg.name, msg.url);
          break;
        }
        case 'boardRemovePart': {
          if (conn.audience !== 'staff') return;
          if (typeof msg.entryId !== 'string') return;
          if (typeof msg.partId !== 'string') return;
          void boardRemovePart(msg.entryId, msg.partId);
          break;
        }
        case 'boardReceivePart': {
          // Received a part — remove it from the active list and drop a
          // comment so there's an audit trail of what arrived and when.
          if (conn.audience !== 'staff' || !user) return;
          if (typeof msg.entryId !== 'string') return;
          if (typeof msg.partId !== 'string') return;
          const entry = boardGetAllSync().find(e => e.id === msg.entryId);
          const part = entry?.parts.find(p => p.id === msg.partId);
          if (!part) return;
          const body = `📦 Received: ${part.name}${part.url ? `\n${part.url}` : ''}`;
          await boardRemovePart(msg.entryId, msg.partId);
          await boardAddComment(msg.entryId, { name: user.name, email: user.email }, body);
          break;
        }
        case 'boardEditComment': {
          if (conn.audience !== 'staff') return;
          if (typeof msg.entryId !== 'string') return;
          if (typeof msg.commentId !== 'string') return;
          if (typeof msg.body !== 'string') return;
          void boardEditComment(msg.entryId, msg.commentId, msg.body);
          break;
        }
        case 'boardDeleteComment': {
          if (conn.audience !== 'staff') return;
          if (typeof msg.entryId !== 'string') return;
          if (typeof msg.commentId !== 'string') return;
          void boardDeleteComment(msg.entryId, msg.commentId);
          break;
        }
        case 'boardUpdateEntry': {
          if (conn.audience !== 'staff') return;
          if (typeof msg.entryId !== 'string') return;
          if (typeof msg.field !== 'string') return;
          const allowed: EditableEntryField[] = [
            'customerName', 'customerEmail', 'customerPhone',
            'deviceModel', 'jobDescription', 'deviceIntent',
          ];
          if (!allowed.includes(msg.field as EditableEntryField)) return;
          void boardUpdateEntry(msg.entryId, msg.field as EditableEntryField, msg.value);
          break;
        }
      }
    });

    socket.on('close', () => {
      connections.delete(conn);
    });
  });
}
