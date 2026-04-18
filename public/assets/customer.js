// Customer-facing display — primarily a mirror, but the intake screen lets
// the customer type their own name/phone/email etc. (staff can also edit
// from their side; both sides sync live via the same `updateField` WS
// message). Everything past intake is read-only.

const $stage = document.getElementById('stage');
let job = null;
let ws = null;

// Deep-merge echoes in place so that while the customer is typing in an
// input, an incoming WS state snapshot doesn't replace the DOM and clobber
// their caret / partially-typed value. Only re-render when something
// structural changes (step, route, signature request, etc.).
function mergeInPlace(dest, src) {
  if (!dest || !src) return;
  for (const key of Object.keys(src)) {
    const dv = dest[key];
    const sv = src[key];
    if (Array.isArray(dv) && Array.isArray(sv) && dv.length === sv.length) {
      for (let i = 0; i < dv.length; i++) {
        if (dv[i] && sv[i] && typeof dv[i] === 'object') mergeInPlace(dv[i], sv[i]);
        else dv[i] = sv[i];
      }
    } else if (dv && sv && typeof dv === 'object' && typeof sv === 'object' && !Array.isArray(sv)) {
      mergeInPlace(dv, sv);
    } else {
      dest[key] = sv;
    }
  }
}

// Which fields of which top-level keys are rendered as plain text inside
// inputs — safe to just update the DOM value instead of re-rendering. All
// other changes (step, signatureRequest, route, etc.) are structural.
function isStructural(prev, next) {
  if (!prev || !next) return true;
  if (prev.id !== next.id) return true;
  if (prev.step !== next.step) return true;
  if ((prev.signatureRequest?.kind ?? null) !== (next.signatureRequest?.kind ?? null)) return true;
  if (Boolean(prev.signatureRequest) !== Boolean(next.signatureRequest)) return true;
  if ((prev.checkout?.state ?? null) !== (next.checkout?.state ?? null)) return true;
  if ((prev.pickup?.loadState ?? null) !== (next.pickup?.loadState ?? null)) return true;
  if ((prev.pickup?.selectedInvoiceId ?? null) !== (next.pickup?.selectedInvoiceId ?? null)) return true;
  // Repair / product / onTheSpot line count changes restructure the mirror.
  if ((prev.repair?.lines?.length ?? 0) !== (next.repair?.lines?.length ?? 0)) return true;
  if ((prev.product?.lines?.length ?? 0) !== (next.product?.lines?.length ?? 0)) return true;
  if ((prev.pickup?.extraLines?.length ?? 0) !== (next.pickup?.extraLines?.length ?? 0)) return true;
  return false;
}

function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function sendUpdateField(field, value) {
  try { ws?.send(JSON.stringify({ type: 'updateField', field, value })); }
  catch { /* swallow — next state will resync */ }
}
const sendUpdateFieldDebounced = debounce(sendUpdateField, 200);

function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'subscribe', audience: 'customer' }));
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'state') {
      const next = msg.job;
      if (window.__cmDebugSig) console.log('[customer] state received', {
        step: next?.step,
        signatureRequest: next?.signatureRequest,
      });
      if (isStructural(job, next)) {
        job = next;
        render();
      } else if (job && next) {
        // Non-structural echo — merge in place so focused inputs aren't lost.
        mergeInPlace(job, next);
        syncIntakeInputs();
      } else {
        job = next;
        render();
      }
    }
  });
  ws.addEventListener('close', () => setTimeout(connectWs, 500));
}

// When the staff side updates a field while the customer is on the intake
// screen, refresh each input's value *unless* that input currently has
// focus (never stomp the user's own typing). Called after a merge-in-place.
function syncIntakeInputs() {
  if (job?.step !== 'intake') return;
  const c = job.customer || {};
  const fields = ['firstName', 'lastName', 'phone', 'email', 'postcode', 'company'];
  for (const f of fields) {
    const el = document.querySelector(`[data-intake-field="${f}"]`);
    if (!el) continue;
    if (document.activeElement === el) continue;
    const v = c[f] ?? '';
    if (el.value !== v) el.value = v;
  }
}

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (v !== undefined && v !== null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

function brandHeader() {
  return h('div', { class: 'stage-brand' },
    h('img', { src: '/assets/logo.jpg', alt: 'Computer Mechanics', class: 'stage-brand-logo' }),
  );
}

function viewStandby() {
  return h('div', { class: 'stage-standby' },
    brandHeader(),
    h('h1', {}, 'Welcome to Computer Mechanics'),
    h('p', {}, 'Please wait — our team will be with you shortly.'),
    h('p', { class: 'muted' }, 'This screen will light up when a staff member starts your job.'),
  );
}

function row(label, value) {
  const isEmpty = !value;
  return h('div', { class: 'row' },
    h('div', { class: 'label' }, label),
    h('div', { class: `value ${isEmpty ? 'empty' : ''}` }, isEmpty ? '—' : value),
  );
}

function viewIntake(job) {
  const c = job.customer;

  // Editable field. The customer can fill these in themselves; staff can
  // also type on their side and both stay in sync via `updateField`.
  // `data-intake-field` lets syncIntakeInputs() refresh the value on echoes
  // without stomping a focused input.
  const field = (name, label, type = 'text', placeholder = '') => {
    const input = h('input', {
      type,
      name,
      placeholder,
      value: c[name] ?? '',
      autocomplete: 'off',
      spellcheck: 'false',
      class: 'intake-input',
      'data-intake-field': name,
    });
    input.addEventListener('input', (e) => {
      // Update local state immediately so a later merge-in-place doesn't
      // overwrite our own value if it arrives before the debounced send.
      if (job?.customer) job.customer[name] = e.target.value;
      sendUpdateFieldDebounced(name, e.target.value);
    });
    return h('div', { class: 'intake-field' },
      h('label', { class: 'intake-label' }, label),
      input,
    );
  };

  return h('div', { class: 'stage-intake' },
    brandHeader(),
    h('h1', {}, `Welcome${c.firstName ? `, ${c.firstName}` : ''}!`),
    h('p', { class: 'greeting-sub' }, `Please check your details below. You can type them in yourself, or our team will help.`),
    h('div', { class: 'customer-summary customer-summary-form' },
      h('h2', {}, 'Your details'),
      h('div', { class: 'intake-grid' },
        field('firstName', 'First name', 'text', 'e.g. Jamie'),
        field('lastName', 'Last name', 'text', 'e.g. Smith'),
        field('phone', 'Phone', 'tel', '04…'),
        field('email', 'Email', 'email', 'name@example.com'),
        field('postcode', 'Postcode', 'text', '3000'),
        field('company', 'Company (optional)', 'text', ''),
      ),
      c.hasComputerPassword
        ? h('p', { class: 'intake-pw-note' }, '🔒 Computer password recorded with our team.')
        : null,
    ),
  );
}

function viewThanks(job) {
  return h('div', { class: 'stage-thanks' },
    brandHeader(),
    h('h1', {}, `Thanks, ${job.customer.firstName || 'there'}!`),
    h('p', {}, 'Please wait a moment while we continue.'),
  );
}

const ROUTE_LABELS = {
  repair:      { title: 'Booking in your repair', sub: 'Our tech will note down what\'s happening with your device.' },
  product:     { title: 'Putting your order together', sub: 'One moment while we add your items.' },
  on_the_spot: { title: 'Quick fix in progress', sub: 'This should only take a few minutes.' },
  pickup:      { title: 'Picking up your device', sub: 'We\'re pulling up your invoice now.' },
};

function viewRoute(job) {
  const name = job.customer.firstName || 'there';
  return h('div', { class: 'stage-thanks' },
    h('h1', {}, `Thanks, ${name}!`),
    h('p', {}, 'Our team is choosing the right service for you.'),
  );
}

function viewRouteStep(job) {
  const label = ROUTE_LABELS[job.step];
  if (!label) return viewThanks(job);
  const name = job.customer.firstName || 'there';
  return h('div', { class: 'stage-thanks' },
    h('h1', {}, label.title),
    h('p', {}, label.sub),
    h('p', { class: 'muted', style: 'margin-top:32px' }, `We're with you, ${name}.`),
  );
}

function fmtAUD(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

function viewRepairMirror(job) {
  const name = job.customer.firstName || 'there';
  const r = job.repair;
  const lines = (r?.lines ?? []).filter(l => l.service);
  const hasCustom = r?.customServiceName?.trim();
  const total = (r?.lines?.reduce((s, l) => s + (Number(l.cost) || 0), 0) ?? 0)
              + (Number(r?.customServiceAmount) || 0);
  const depositStr = r?.paymentType === 'deposit' && r?.depositAmount
    ? `Deposit today: ${fmtAUD(r.depositAmount)}`
    : r?.paymentType === 'full' ? 'Paying in full today' : null;

  return h('div', { class: 'stage-repair' },
    h('h1', {}, `Hi ${name}!`),
    h('p', { class: 'greeting-sub' }, `Here's what we're booking in for you.`),
    h('div', { class: 'customer-summary' },
      h('h2', {}, 'Services'),
      (lines.length || hasCustom) ? h('div', { class: 'rows' },
        ...lines.map(l => row(
          l.service + (l.variant ? ` — ${l.variant}` : ''),
          l.cost > 0 ? fmtAUD(l.cost) : null,
        )),
        hasCustom ? row(r.customServiceName, r.customServiceAmount ? fmtAUD(r.customServiceAmount) : null) : null,
      ) : h('p', { class: 'muted', style: 'padding:16px 0' }, 'Our tech is adding services now…'),
    ),
    r?.jobDescription ? h('div', { class: 'customer-summary', style: 'margin-top:16px' },
      h('h2', {}, 'What we\'ll do'),
      h('p', { class: 'repair-desc' }, r.jobDescription),
    ) : null,
    h('div', { class: 'repair-total-row' },
      h('div', {}, 'Total (inc. GST)'),
      h('div', { class: 'total-amount' }, fmtAUD(total)),
    ),
    depositStr ? h('p', { class: 'muted', style: 'margin-top:8px' }, depositStr) : null,
  );
}

function viewProductMirror(job) {
  const name = job.customer.firstName || 'there';
  const p = job.product;
  const lines = (p?.lines ?? []).filter(l => l.name);
  const total = (p?.lines ?? []).reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0);
  const depositStr = p?.paymentType === 'deposit' && p?.depositAmount
    ? `Deposit today: ${fmtAUD(p.depositAmount)}`
    : p?.paymentType === 'full' ? 'Paying in full today' : null;

  return h('div', { class: 'stage-repair' },
    h('h1', {}, `Hi ${name}!`),
    h('p', { class: 'greeting-sub' }, `Here's what you're buying today.`),
    h('div', { class: 'customer-summary' },
      h('h2', {}, 'Items'),
      lines.length ? h('div', { class: 'rows' },
        ...lines.map(l => row(
          `${l.name}${l.qty > 1 ? ` × ${l.qty}` : ''}`,
          l.unitPrice > 0 ? fmtAUD((Number(l.qty) || 0) * (Number(l.unitPrice) || 0)) : null,
        )),
      ) : h('p', { class: 'muted', style: 'padding:16px 0' }, 'Our tech is adding your items now…'),
    ),
    h('div', { class: 'repair-total-row' },
      h('div', {}, 'Total (inc. GST)'),
      h('div', { class: 'total-amount' }, fmtAUD(total)),
    ),
    depositStr ? h('p', { class: 'muted', style: 'margin-top:8px' }, depositStr) : null,
  );
}

function viewOnTheSpotMirror(job) {
  const name = job.customer.firstName || 'there';
  const o = job.onTheSpot;
  const price = Number(o?.price) || 0;
  const hours = Number(o?.hours) || 0;
  const rate  = Number(o?.hourlyRate) || 0;
  const hourlySubtotal = hours * rate;
  const total = price + hourlySubtotal;
  const depositStr = o?.paymentType === 'deposit' && o?.depositAmount
    ? `Deposit today: ${fmtAUD(o.depositAmount)}`
    : o?.paymentType === 'full' ? 'Paying in full today' : null;

  const hoursLabel = hours === 0 ? null
                   : hours < 1 ? `${Math.round(hours * 60)} min @ ${fmtAUD(rate)}/hr`
                   : `${hours} ${hours === 1 ? 'hour' : 'hours'} @ ${fmtAUD(rate)}/hr`;

  return h('div', { class: 'stage-repair' },
    h('h1', {}, `Hi ${name}!`),
    h('p', { class: 'greeting-sub' }, `Here's your quick fix today.`),
    h('div', { class: 'customer-summary' },
      h('h2', {}, 'What we did'),
      (o?.description || price > 0 || hours > 0)
        ? h('div', { class: 'rows' },
            o?.description ? row(o.description, price > 0 ? fmtAUD(price) : null) : null,
            hoursLabel ? row(hoursLabel, fmtAUD(hourlySubtotal)) : null,
          )
        : h('p', { class: 'muted', style: 'padding:16px 0' }, 'Our tech is noting it down now…'),
    ),
    h('div', { class: 'repair-total-row' },
      h('div', {}, 'Total (inc. GST)'),
      h('div', { class: 'total-amount' }, fmtAUD(total)),
    ),
    depositStr ? h('p', { class: 'muted', style: 'margin-top:8px' }, depositStr) : null,
  );
}

// Selected invoice can live in either the grouped job list or the flat
// fallback list — mirror of findPickupInvoice() in src/job.ts.
function findSelectedPickupInvoice(pu) {
  if (!pu?.selectedInvoiceId) return null;
  const id = pu.selectedInvoiceId;
  for (const g of (pu.jobGroups || [])) {
    const hit = (g.invoices || []).find(i => i.invoiceId === id);
    if (hit) return hit;
  }
  return (pu.invoices || []).find(i => i.invoiceId === id) || null;
}

function pickupTotals(pu) {
  const inv = findSelectedPickupInvoice(pu);
  const invoiceDue = Number(inv?.amountDue) || 0;
  const extrasTotal = (pu?.extraLines ?? []).reduce((s, l) => s + (Number(l.amount) || 0), 0);
  return { inv, invoiceDue, extrasTotal, total: invoiceDue + extrasTotal };
}

function viewPickupMirror(job) {
  const name = job.customer.firstName || 'there';
  const pu = job.pickup;

  if (!pu || pu.loadState === 'loading') {
    return h('div', { class: 'stage-thanks' },
      h('h1', {}, `Welcome back, ${name}!`),
      h('p', {}, 'Pulling up your invoice now…'),
    );
  }
  if (pu.loadState === 'empty' || pu.loadState === 'error') {
    return h('div', { class: 'stage-thanks' },
      h('h1', {}, `Welcome back, ${name}!`),
      h('p', {}, 'Just a moment — our team is looking you up.'),
    );
  }
  if (!pu.selectedInvoiceId) {
    return h('div', { class: 'stage-thanks' },
      h('h1', {}, `Welcome back, ${name}!`),
      h('p', {}, 'Our tech is finding the right invoice for you.'),
    );
  }

  const { inv, invoiceDue, extrasTotal, total } = pickupTotals(pu);
  if (!inv) return viewThanks(job);

  return h('div', { class: 'stage-repair' },
    h('h1', {}, `Hi ${name}!`),
    h('p', { class: 'greeting-sub' }, `Here's what we're collecting for invoice ${inv.invoiceNumber}.`),
    h('div', { class: 'customer-summary' },
      h('h2', {}, 'Invoice items'),
      h('div', { class: 'rows' },
        ...inv.lineItems.map(li => row(
          li.description + (li.quantity > 1 ? ` × ${li.quantity}` : ''),
          fmtAUD(li.quantity * li.unitPriceIncGst),
        )),
      ),
    ),
    extrasTotal > 0 ? h('div', { class: 'customer-summary', style: 'margin-top:16px' },
      h('h2', {}, 'Extra charges today'),
      h('div', { class: 'rows' },
        ...pu.extraLines
          .filter(l => l.description || l.amount > 0)
          .map(l => row(l.description || 'Extra charge', l.amount > 0 ? fmtAUD(l.amount) : null)),
      ),
    ) : null,
    h('div', { class: 'repair-total-row' },
      h('div', {}, extrasTotal > 0 ? 'Due today (inc. GST)' : 'Balance (inc. GST)'),
      h('div', { class: 'total-amount' }, fmtAUD(total)),
    ),
    Number(inv.amountPaid) > 0 && extrasTotal === 0
      ? h('p', { class: 'muted', style: 'margin-top:8px' }, `${fmtAUD(inv.amountPaid)} deposit already paid.`)
      : null,
  );
}

function checkoutDue(job) {
  const r = job.repair, p = job.product, o = job.onTheSpot, pu = job.pickup;
  if (r) {
    const tot = r.lines.reduce((s, l) => s + (Number(l.cost) || 0), 0) + (Number(r.customServiceAmount) || 0);
    return r.paymentType === 'deposit' ? (Number(r.depositAmount) || 0) : tot;
  }
  if (p) {
    const tot = p.lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0);
    return p.paymentType === 'deposit' ? (Number(p.depositAmount) || 0) : tot;
  }
  if (o) {
    const tot = (Number(o.price) || 0) + (Number(o.hours) || 0) * (Number(o.hourlyRate) || 0);
    return o.paymentType === 'deposit' ? (Number(o.depositAmount) || 0) : tot;
  }
  if (pu) return pickupTotals(pu).total;
  return 0;
}

function viewCheckoutMirror(job) {
  const name = job.customer.firstName || 'there';
  const due = checkoutDue(job);
  const c = job.checkout || { state: 'choosing', method: null, cashTendered: 0, receipt: null };

  if (c.state === 'done') {
    const r = c.receipt || {};
    const method = r.method || c.method;
    const paid = Number(r.amountPaid) || 0;
    const line = method === 'pay_later'
      ? 'Your invoice has been emailed — pay at your convenience.'
      : method === 'cash'
        ? `Cash received: ${fmtAUD(paid)}${r.changeGiven ? ` (change ${fmtAUD(r.changeGiven)})` : ''}.`
        : `Card approved: ${fmtAUD(paid)}${r.cardType ? ` — ${r.cardType}${r.cardLastFour ? ` •••• ${r.cardLastFour}` : ''}` : ''}.`;
    return h('div', { class: 'stage-thanks' },
      h('h1', {}, `Thanks, ${name}!`),
      h('p', {}, line),
      job.customer.email ? h('p', { class: 'muted', style: 'margin-top:16px' },
        method === 'pay_later'
          ? `Invoice sent to ${job.customer.email}.`
          : `Receipt sent to ${job.customer.email}.`) : null,
      method !== 'pay_later' && job.pickup
        ? h('p', { class: 'muted', style: 'margin-top:16px' },
          'We\'d love to hear how we went — you\'ll get a short review request by email in a moment.')
        : null,
    );
  }

  if (c.state === 'error') {
    return h('div', { class: 'stage-thanks' },
      h('h1', {}, 'One moment, please'),
      h('p', {}, 'Our team is sorting this out for you.'),
    );
  }

  if (c.state === 'card_charging') {
    return h('div', { class: 'stage-thanks' },
      h('h1', {}, `Paying ${fmtAUD(due)}`),
      h('p', {}, 'Please tap, insert or swipe your card on the terminal.'),
    );
  }

  if (c.state === 'card_declined') {
    return h('div', { class: 'stage-thanks' },
      h('h1', {}, 'Card declined'),
      h('p', {}, 'No worries — we\'ll try again or use a different payment method.'),
    );
  }

  if (c.state === 'processing') {
    return h('div', { class: 'stage-thanks' },
      h('h1', {}, `Thanks, ${name}!`),
      h('p', {}, 'Finishing up — one moment please.'),
    );
  }

  if (c.state === 'cash_entry') {
    const tendered = Number(c.cashTendered) || 0;
    const change = Math.max(0, tendered - due);
    return h('div', { class: 'stage-repair' },
      h('h1', {}, `Paying ${fmtAUD(due)}`),
      h('p', { class: 'greeting-sub' }, 'Cash at the counter.'),
      h('div', { class: 'customer-summary' },
        h('div', { class: 'rows' },
          row('Amount due', fmtAUD(due)),
          row('Tendered', tendered > 0 ? fmtAUD(tendered) : null),
          row('Change', tendered >= due ? fmtAUD(change) : null),
        ),
      ),
    );
  }

  // choosing (default)
  return h('div', { class: 'stage-thanks' },
    h('h1', {}, 'Ready to pay?'),
    h('p', {}, `Amount due: ${fmtAUD(due)}`),
    h('p', { class: 'muted', style: 'margin-top:24px' }, 'Our tech will start the payment for you.'),
  );
}

// ── Signature capture ──────────────────────────────────────────────────────
// Keyed by SignatureRequest.requestedAt so re-requests rebuild the canvas.

const SIGNATURE_COPY = {
  drop_off: {
    heading: 'Authorise us to proceed',
    body:
      'By signing below, you give Computer Mechanics authority to carry out the ' +
      'work described on this screen and agree to our terms & conditions — ' +
      'including minimum service charges where faults cannot be rectified.',
    acknowledge:
      'I have read and agreed to the terms & conditions and authorise Computer Mechanics to proceed.',
    button: 'Sign & authorise',
  },
  pick_up: {
    heading: 'Confirm you\'re happy',
    body:
      'By signing below, you confirm that the work described has been completed ' +
      'to your satisfaction and you\'re collecting your device.',
    acknowledge:
      'I am satisfied that the above work has been completed as requested.',
    button: 'Sign & confirm',
  },
};

let signatureState = null; // { key, canvas, ctx, hasInk, onSubmit, onClear }

function teardownSignatureState() {
  if (!signatureState) return;
  const { canvas } = signatureState;
  // Detach any outstanding listeners via element replacement.
  canvas.replaceWith(canvas.cloneNode(false));
  signatureState = null;
}

function viewSignaturePad(job, req) {
  const copy = SIGNATURE_COPY[req.kind] ?? SIGNATURE_COPY.drop_off;
  const name = [job.customer.firstName, job.customer.lastName].filter(Boolean).join(' ');

  const canvas = document.createElement('canvas');
  canvas.className = 'sig-canvas';
  // Logical size picked to match the receipt's signature line proportions.
  const logicalW = 720;
  const logicalH = 220;
  canvas.width = logicalW;
  canvas.height = logicalH;
  canvas.style.touchAction = 'none';

  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, logicalW, logicalH);
  ctx.strokeStyle = '#0b0b0b';
  ctx.lineWidth = 2.8;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  let drawing = false;
  let hasInk = false;
  let lastX = 0;
  let lastY = 0;

  const submitBtn = document.createElement('button');
  const clearBtn = document.createElement('button');

  function setButtons() {
    submitBtn.disabled = !hasInk;
    clearBtn.disabled = !hasInk;
  }

  function canvasPos(ev) {
    const rect = canvas.getBoundingClientRect();
    const x = (ev.clientX - rect.left) * (canvas.width / rect.width);
    const y = (ev.clientY - rect.top) * (canvas.height / rect.height);
    return { x, y };
  }

  canvas.addEventListener('pointerdown', (ev) => {
    ev.preventDefault();
    canvas.setPointerCapture(ev.pointerId);
    drawing = true;
    const { x, y } = canvasPos(ev);
    lastX = x; lastY = y;
    // Dot for taps so a quick touch still shows ink.
    ctx.beginPath();
    ctx.arc(x, y, 1.4, 0, Math.PI * 2);
    ctx.fillStyle = '#0b0b0b';
    ctx.fill();
    hasInk = true;
    setButtons();
  });
  canvas.addEventListener('pointermove', (ev) => {
    if (!drawing) return;
    const { x, y } = canvasPos(ev);
    ctx.beginPath();
    ctx.moveTo(lastX, lastY);
    ctx.lineTo(x, y);
    ctx.stroke();
    lastX = x; lastY = y;
  });
  const endStroke = () => { drawing = false; };
  canvas.addEventListener('pointerup', endStroke);
  canvas.addEventListener('pointercancel', endStroke);
  canvas.addEventListener('pointerleave', endStroke);

  function doClear() {
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, logicalW, logicalH);
    ctx.strokeStyle = '#0b0b0b';
    hasInk = false;
    setButtons();
  }

  function doSubmit() {
    if (!hasInk) return;
    const dataUrl = canvas.toDataURL('image/png');
    submitBtn.disabled = true;
    submitBtn.textContent = 'Sending…';
    try {
      ws?.send(JSON.stringify({ type: 'submitSignature', kind: req.kind, dataUrl }));
    } catch (err) {
      console.error('[signature] Failed to send:', err);
      submitBtn.disabled = false;
      submitBtn.textContent = copy.button;
    }
  }

  clearBtn.type = 'button';
  clearBtn.className = 'sig-btn sig-btn-ghost';
  clearBtn.textContent = 'Clear';
  clearBtn.addEventListener('click', doClear);

  submitBtn.type = 'button';
  submitBtn.className = 'sig-btn sig-btn-primary';
  submitBtn.textContent = copy.button;
  submitBtn.addEventListener('click', doSubmit);

  setButtons();

  signatureState = { key: req.requestedAt, canvas, ctx };

  return h('div', { class: 'stage-signature' },
    h('div', { class: 'sig-card' },
      h('h1', {}, copy.heading),
      h('p', { class: 'sig-intro' }, copy.body),
      name ? h('p', { class: 'sig-name' }, `Signing as `, h('strong', {}, name)) : null,
      h('div', { class: 'sig-pad-wrap' },
        canvas,
        h('div', { class: 'sig-pad-baseline' }),
        h('div', { class: 'sig-pad-hint' }, 'Sign here with your finger or stylus'),
      ),
      h('p', { class: 'sig-acknowledge' }, copy.acknowledge),
      h('div', { class: 'sig-actions' }, clearBtn, submitBtn),
    ),
  );
}

function render() {
  const req = job?.signatureRequest ?? null;
  if (window.__cmDebugSig) console.log('[customer] render', { step: job?.step, req });

  // Active signature request — show the pad and short-circuit the normal
  // step-based view. Rebuild only when the request key changes so we don't
  // wipe the customer's in-progress ink on every WS echo.
  if (req) {
    if (signatureState?.key !== req.requestedAt) {
      try {
        teardownSignatureState();
        $stage.replaceChildren(viewSignaturePad(job, req));
      } catch (err) {
        console.error('[customer] failed to mount signature pad:', err);
        signatureState = null;
        $stage.replaceChildren(
          h('div', { class: 'stage-thanks' },
            h('h1', {}, 'One moment…'),
            h('p', {}, 'Please ask our team for assistance.'),
          ),
        );
      }
    }
    return;
  }

  // Request cleared — tear down the pad if one was mounted, then fall through.
  if (signatureState) teardownSignatureState();

  let view;
  if (!job) view = viewStandby();
  else if (job.step === 'intake') view = viewIntake(job);
  else if (job.step === 'route') view = viewRoute(job);
  else if (job.step === 'repair') view = viewRepairMirror(job);
  else if (job.step === 'product') view = viewProductMirror(job);
  else if (job.step === 'on_the_spot') view = viewOnTheSpotMirror(job);
  else if (job.step === 'pickup') view = viewPickupMirror(job);
  else if (job.step === 'checkout') view = viewCheckoutMirror(job);
  else if (ROUTE_LABELS[job.step]) view = viewRouteStep(job);
  else view = viewThanks(job);
  $stage.replaceChildren(view);
}

connectWs();
render();
