// Staff screen — dashboard, intake form, and WebSocket sync to the customer display.

const $app = document.getElementById('app');
const $badge = document.getElementById('job-badge');
const $meName = document.getElementById('me-name');

let job = null;        // authoritative: whatever the server last sent us
let ws = null;
let wsReady = false;
let pendingSends = [];  // queued while socket is connecting / reconnecting
let lastStep1Result = null;
let lastRepairResult = null;
let lastProductResult = null;
let lastOnTheSpotResult = null;
let lastPickupResult = null;

// ── WebSocket ──────────────────────────────────────────────────────────────
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.addEventListener('open', () => {
    wsReady = true;
    ws.send(JSON.stringify({ type: 'subscribe', audience: 'staff' }));
    // Flush anything that was queued while we were connecting/reconnecting.
    for (const msg of pendingSends) {
      try { ws.send(JSON.stringify(msg)); } catch { /* drop */ }
    }
    pendingSends = [];
    updateConnIndicator();
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'state') {
      const prev = job;
      const next = msg.job;
      // Only re-render when the view structure needs to change. Skipping same-step
      // field echoes prevents blowing away the input the user is typing into.
      const prevRepairLines   = prev?.repair?.lines?.length       ?? 0;
      const nextRepairLines   = next?.repair?.lines?.length       ?? 0;
      const prevProductLines  = prev?.product?.lines?.length      ?? 0;
      const nextProductLines  = next?.product?.lines?.length      ?? 0;
      const prevPickupExtras  = prev?.pickup?.extraLines?.length  ?? 0;
      const nextPickupExtras  = next?.pickup?.extraLines?.length  ?? 0;
      const structural =
        !prev ||
        !next ||
        prev.id !== next.id ||
        prev.step !== next.step ||
        prevRepairLines  !== nextRepairLines ||
        prevProductLines !== nextProductLines ||
        prevPickupExtras !== nextPickupExtras ||
        // Pickup load state and selection change the entire view layout.
        (prev.pickup?.loadState        ?? null) !== (next.pickup?.loadState        ?? null) ||
        (prev.pickup?.selectedInvoiceId ?? null) !== (next.pickup?.selectedInvoiceId ?? null) ||
        // Checkout state transitions swap the entire panel (choosing → cash_entry → done …)
        (prev.checkout?.state ?? null) !== (next.checkout?.state ?? null) ||
        // Signature card swaps between empty / waiting / captured presentations.
        (prev.signatureRequest?.kind ?? null) !== (next.signatureRequest?.kind ?? null) ||
        Boolean(prev.signatures?.dropOff) !== Boolean(next.signatures?.dropOff) ||
        Boolean(prev.signatures?.pickUp) !== Boolean(next.signatures?.pickUp);
      if (structural) {
        job = next;
        render();
      } else {
        // Non-structural echo: merge fields IN PLACE so closures that captured
        // job / job.onTheSpot / job.repair keep pointing to live objects.
        // Without this, clicking a chip mutates a stale object and render() sees
        // the server's fresh object, producing the "click twice" bug.
        mergeInPlace(prev, next);
      }
    } else if (msg.type === 'step1Result') {
      lastStep1Result = msg.result;
      render();
    } else if (msg.type === 'repairResult') {
      lastRepairResult = msg.result;
      if (!msg.result?.ok) render();
    } else if (msg.type === 'productResult') {
      lastProductResult = msg.result;
      if (!msg.result?.ok) render();
    } else if (msg.type === 'onTheSpotResult') {
      lastOnTheSpotResult = msg.result;
      if (!msg.result?.ok) render();
    } else if (msg.type === 'pickupResult') {
      lastPickupResult = msg.result;
      if (!msg.result?.ok) render();
    }
  });
  ws.addEventListener('close', () => {
    wsReady = false;
    updateConnIndicator();
    // Simple auto-reconnect — faster than the old 1500ms so returning from lock
    // screen feels responsive.
    setTimeout(connectWs, 500);
  });
  ws.addEventListener('error', () => {
    wsReady = false;
    updateConnIndicator();
  });
}

function wsSend(msg) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(msg));
  } else {
    // Queue — will flush on next 'open'. Prevents the "I clicked but nothing
    // happened" bug when the socket is briefly reconnecting.
    pendingSends.push(msg);
  }
}

function updateConnIndicator() {
  const el = document.getElementById('conn-indicator');
  if (!el) return;
  el.classList.toggle('offline', !wsReady);
  el.title = wsReady ? 'Connected' : 'Reconnecting…';
}

// ── View helpers ───────────────────────────────────────────────────────────
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'checked' || k === 'disabled' || k === 'autofocus') { if (v) el.setAttribute(k, ''); }
    else if (v !== undefined && v !== null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
}

// Deep-merge `src` into `dest` preserving object / array identity. Used on
// non-structural WS state echoes so that closures captured by the current view
// (which reference specific job / job.onTheSpot / job.repair / line objects)
// stay pointing at the live, up-to-date values.
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

// ── Views ──────────────────────────────────────────────────────────────────
function viewDashboard() {
  return h('div', { class: 'dashboard-hero' },
    h('h1', {}, 'Ready to start a new job.'),
    h('p', {}, 'Click below when a customer walks in. The customer-facing screen will update live.'),
    h('button', {
      class: 'btn btn-primary btn-new-job',
      onclick: () => {
        lastStep1Result = null;
        lastRepairResult = null;
        lastProductResult = null;
        lastOnTheSpotResult = null;
        lastPickupResult = null;
        wsSend({ type: 'newJob' });
      },
    }, 'New Job'),
  );
}

function splitCustomerName(full) {
  const parts = String(full || '').trim().split(/\s+/);
  if (parts.length === 0 || !parts[0]) return { firstName: '', lastName: '' };
  if (parts.length === 1) return { firstName: parts[0], lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

function viewIntake(job) {
  const c = job.customer;
  const pushField = (field, value) => wsSend({ type: 'updateField', field, value });
  const pushFieldDebounced = debounce(pushField, 200);

  const input = (name, type = 'text', placeholder = '', attrs = {}) => h('input', {
    type, name, placeholder, value: c[name] ?? '', autocomplete: 'off',
    oninput: (e) => pushFieldDebounced(name, e.target.value),
    ...attrs,
  });

  // Customer lookup — search existing board customers and autofill.
  const searchInput = h('input', {
    type: 'search',
    placeholder: 'Search existing customers by name, phone, email…',
    autocomplete: 'off',
    spellcheck: 'false',
    class: 'customer-search-input',
  });
  const resultsEl = h('div', { class: 'customer-search-results' });
  let searchToken = 0;
  const hideResults = () => { resultsEl.innerHTML = ''; resultsEl.classList.remove('show'); };
  const applySuggestion = (s) => {
    const { firstName, lastName } = splitCustomerName(s.name);
    pushField('firstName', firstName);
    pushField('lastName', lastName);
    pushField('phone', s.phone || '');
    pushField('email', s.email || '');
    // Update the local job object so re-render reflects immediately.
    job.customer.firstName = firstName;
    job.customer.lastName = lastName;
    job.customer.phone = s.phone || '';
    job.customer.email = s.email || '';
    searchInput.value = '';
    hideResults();
    render();
  };
  const runSearch = debounce(async (q) => {
    const token = ++searchToken;
    if (!q.trim()) { hideResults(); return; }
    try {
      const r = await fetch('/api/customers/search?q=' + encodeURIComponent(q), { credentials: 'same-origin' });
      if (token !== searchToken) return;
      const data = await r.json();
      const results = Array.isArray(data?.results) ? data.results : [];
      resultsEl.replaceChildren();
      if (results.length === 0) {
        resultsEl.append(h('div', { class: 'customer-search-empty' }, 'No matches on the job board.'));
      } else {
        for (const s of results) {
          resultsEl.append(h('div', {
            class: 'customer-search-item',
            onclick: () => applySuggestion(s),
          },
            h('div', { class: 'customer-search-name' }, s.name || '—'),
            h('div', { class: 'customer-search-meta' },
              s.phone || '',
              s.phone && s.email ? ' · ' : '',
              s.email || '',
              s.jobCount > 1 ? ` · ${s.jobCount} jobs` : '',
            ),
          ));
        }
      }
      resultsEl.classList.add('show');
    } catch { /* swallow — offline or endpoint error */ }
  }, 180);
  searchInput.addEventListener('input', (e) => runSearch(e.target.value));
  searchInput.addEventListener('keydown', (e) => { if (e.key === 'Escape') { searchInput.value = ''; hideResults(); } });
  // Click outside → close dropdown
  setTimeout(() => {
    const off = (ev) => {
      if (!resultsEl.contains(ev.target) && ev.target !== searchInput) hideResults();
    };
    document.addEventListener('click', off, { once: false });
  }, 0);

  const fieldEl = (label, inputEl, hint) => h('div', { class: 'field' },
    h('label', {}, label),
    inputEl,
    hint ? h('div', { class: 'hint' }, hint) : null,
  );

  const passwordInput = h('input', {
    type: 'password',
    name: 'computerPassword',
    value: c.computerPassword ?? '',
    placeholder: 'Computer password',
    autocomplete: 'off',
    oninput: (e) => pushField('computerPassword', e.target.value),
  });
  const showBtn = h('button', {
    type: 'button',
    onclick: () => {
      passwordInput.type = passwordInput.type === 'password' ? 'text' : 'password';
      showBtn.textContent = passwordInput.type === 'password' ? 'Show' : 'Hide';
    },
  }, 'Show');

  const resultBanner = lastStep1Result
    ? (lastStep1Result.ok
        ? h('div', { class: 'result-banner ok' },
            lastStep1Result.isExistingContact
              ? `Found existing customer in Xero: ${lastStep1Result.contactName}`
              : `Created new customer in Xero: ${lastStep1Result.contactName}`,
          )
        : h('div', { class: 'result-banner err' },
            lastStep1Result.error === 'missing_required_fields'
              ? `Please fill: ${(lastStep1Result.missing ?? []).join(', ')}`
              : `Error: ${lastStep1Result.error}`,
          ))
    : null;

  return h('div', {},
    h('h1', {}, 'Customer details'),
    h('p', { class: 'sub' }, 'Fill this in with the customer. The customer-facing screen updates as you type.'),
    h('div', { class: 'card' },
      h('div', { class: 'customer-search' },
        h('label', { class: 'customer-search-label' }, '🔎 Returning customer?'),
        searchInput,
        resultsEl,
        h('div', { class: 'hint' }, 'Pick from past jobs to auto-fill name, phone, and email.'),
      ),
      h('div', { class: 'intake-grid' },
        fieldEl('First name',  input('firstName',  'text', 'e.g. Jamie')),
        fieldEl('Last name',   input('lastName',   'text', 'e.g. Smith')),
        fieldEl('Phone',       input('phone',      'tel',  '04...')),
        fieldEl('Email',       input('email',      'email', 'name@example.com')),
        fieldEl('Postcode',    input('postcode',   'text', '3000')),
        fieldEl('Company',     input('company',    'text', 'Optional')),
      ),

      h('div', { style: 'margin-top:16px;padding-top:16px;border-top:1px solid var(--border)' },
        h('label', { class: 'checkbox-row' },
          h('input', {
            type: 'checkbox',
            checked: c.hasComputerPassword,
            onchange: (e) => {
              // Update local view immediately so the password field appears/disappears
              // without waiting for the server echo (which we now intentionally ignore
              // for same-step updates).
              job.customer.hasComputerPassword = e.target.checked;
              render();
              wsSend({ type: 'updateField', field: 'hasComputerPassword', value: e.target.checked });
            },
          }),
          h('span', {}, 'Customer has a password on their computer'),
        ),
        c.hasComputerPassword ? (
          job.passwordRecordId
            ? h('div', { class: 'field' },
                h('label', {}, 'Computer password'),
                h('div', { style: 'display:flex;gap:10px;align-items:center;flex-wrap:wrap' },
                  h('span', { class: 'pwd-saved-badge' }, '✓ Encrypted & stored'),
                  h('button', {
                    type: 'button',
                    class: 'btn btn-ghost btn-sm-top',
                    style: 'margin-left:0',
                    onclick: () => revealPasswordForActiveJob(job),
                  }, 'Reveal'),
                ),
                h('div', { class: 'hint' }, 'Auto-purged 30 days after intake. Each reveal is logged.'),
              )
            : h('div', { class: 'field' },
                h('label', {}, 'Computer password'),
                h('div', { class: 'password-row' }, passwordInput, showBtn),
                h('div', { class: 'hint' }, 'Encrypted at rest on submit and auto-deleted 30 days after pickup.'),
              )
        ) : null,
      ),

      h('div', { style: 'margin-top:16px;padding-top:16px;border-top:1px solid var(--border)' },
        h('div', { class: 'intent-label' }, 'Where is the device?'),
        h('div', { class: 'intent-sub' }, 'Is the customer leaving the device with us, or taking it with them?'),
        h('div', { class: 'intent-btns' },
          ...[
            { key: 'leaving', label: 'In store' },
            { key: 'taking', label: 'With the customer' },
            { key: 'na', label: 'N/A' },
          ].map(opt => h('button', {
            type: 'button',
            class: c.deviceIntent === opt.key ? 'intent-btn selected' : 'intent-btn',
            onclick: () => {
              job.customer.deviceIntent = opt.key;
              render();
              wsSend({ type: 'updateField', field: 'deviceIntent', value: opt.key });
            },
          }, opt.label)),
        ),
      ),

      resultBanner,

      h('div', { class: 'form-actions' },
        h('button', {
          class: 'btn btn-ghost',
          onclick: () => { if (confirm('Cancel this job?')) wsSend({ type: 'clearJob' }); },
        }, 'Cancel'),
        h('div', { class: 'spacer' }),
        h('button', {
          class: 'btn btn-primary',
          onclick: () => { lastStep1Result = null; render(); wsSend({ type: 'submitStep1' }); },
        }, 'Next →'),
      ),
    ),
  );
}

// ── Step 2 — Router ─────────────────────────────────────────────────────────
const ROUTE_TILES = [
  {
    route: 'repair',
    title: 'Repair',
    sub: 'Book in a device for diagnosis and repair.',
    icon: '🛠',
  },
  {
    route: 'product',
    title: 'Product',
    sub: 'Sell parts, peripherals, or accessories.',
    icon: '📦',
  },
  {
    route: 'on_the_spot',
    title: 'On the spot',
    sub: 'Quick fix done while the customer waits.',
    icon: '⚡',
  },
  {
    route: 'pickup',
    title: 'Pickup',
    sub: 'Customer is here to collect a completed job.',
    icon: '🎁',
  },
];

function viewRouter(job) {
  const name = [job.customer.firstName, job.customer.lastName].filter(Boolean).join(' ') || 'this customer';
  return h('div', { class: 'router-view' },
    h('h1', {}, 'What are we doing today?'),
    h('p', { class: 'sub' }, `${name} is in Xero. Pick the right flow to continue.`),
    job.passwordRecordId ? h('div', { style: 'display:flex;justify-content:center;gap:10px;align-items:center;margin-bottom:20px;flex-wrap:wrap' },
      h('span', { class: 'pwd-saved-badge' }, '✓ Computer password encrypted'),
      h('button', {
        class: 'btn btn-ghost btn-sm-top',
        style: 'margin-left:0',
        onclick: () => revealPasswordForActiveJob(job),
      }, 'Reveal'),
    ) : null,
    h('div', { class: 'route-tiles' },
      ...ROUTE_TILES.map(t => h('button', {
        class: 'route-tile',
        onclick: () => wsSend({ type: 'chooseRoute', route: t.route }),
      },
        h('div', { class: 'tile-icon' }, t.icon),
        h('div', { class: 'tile-title' }, t.title),
        h('div', { class: 'tile-sub' }, t.sub),
      )),
    ),
    h('div', { class: 'router-footer' },
      h('button', {
        class: 'btn btn-ghost',
        onclick: () => { if (confirm('Cancel this job?')) wsSend({ type: 'clearJob' }); },
      }, 'Cancel job'),
    ),
  );
}

// ── Route placeholders — each will become a real flow in a later session ───
function routePlaceholder(job, { title, sub, note }) {
  return h('div', { class: 'card placeholder-card' },
    h('div', { class: 'icon' }, '✓'),
    h('h1', {}, title),
    h('p', { class: 'sub', style: 'margin:12px auto 24px;max-width:480px' }, sub),
    h('p', { class: 'muted' }, note),
    h('div', { class: 'form-actions', style: 'max-width:480px;margin:32px auto 0' },
      h('button', {
        class: 'btn btn-ghost',
        onclick: () => wsSend({ type: 'backToRouter' }),
      }, '← Back'),
      h('div', { class: 'spacer' }),
      h('button', {
        class: 'btn btn-ghost',
        onclick: () => { if (confirm('Finish and clear this job?')) wsSend({ type: 'clearJob' }); },
      }, 'Finish'),
    ),
  );
}

// ── Repair flow ────────────────────────────────────────────────────────────
// Catalog lifted from the existing job-intake-form. Prices are GST-inclusive.
const SERVICE_OPTIONS = [
  'Inspection Fee', 'Screen Replacement', 'Battery Replacement',
  'Top Lid Replacement', 'Palm Rest Replacement', 'Fan Replacement',
  'Internal Cleanout + Repaste', 'Windows Install', 'MacOS Install',
  'Linux Install', 'Speakers Replacement', 'Trackpad Replacement',
  'Keyboard Replacement', 'Motherboard Replacement', 'Heatsink Replacement',
  'RAM Upgrade/Replacement', 'SSD Replacement', 'Charge Port Replacement',
  'CPU Replacement', 'Install Customer Provided Parts',
];

// Services with fixed prices; no variant needed — pick from dropdown and cost auto-fills.
const SERVICE_PRICES = {
  'Inspection Fee': 85,
  'Top Lid Replacement': 400,
  'Palm Rest Replacement': 400,
  'Internal Cleanout + Repaste': 175,
  'Windows Install': 200,
  'MacOS Install': 200,
  'Linux Install': 200,
  'Install Customer Provided Parts': 175,
};

// Services with variant pricing. Each variant has a label and a price.
const SERVICE_VARIANTS = {
  'Screen Replacement': [
    { label: 'Non-touch', price: 380 },
    { label: 'Touchscreen', price: 580 },
  ],
  'SSD Replacement': [
    { label: '256GB', price: 400 },
    { label: '512GB', price: 400 },
    { label: '1TB', price: 480 },
  ],
  'RAM Upgrade/Replacement': [
    { label: 'Add 8GB', price: 120 },
    { label: 'Add 16GB', price: 200 },
    { label: 'Add 32GB', price: 320 },
    { label: 'Replace 8GB', price: 140 },
    { label: 'Replace 16GB', price: 220 },
    { label: 'Replace 32GB', price: 340 },
  ],
};

function fmtAUD(n) {
  return `$${(Number(n) || 0).toFixed(2)}`;
}

function computeRepairTotal(r) {
  if (!r) return 0;
  const lineSum = r.lines.reduce((s, l) => s + (Number(l.cost) || 0), 0);
  const custom = Number(r.customServiceAmount) || 0;
  return lineSum + custom;
}

function viewRepair(job) {
  const r = job.repair;
  // Guard: if the server hasn't initialised repair state yet, show loading.
  if (!r) {
    return h('div', { class: 'card' }, h('p', {}, 'Loading repair state…'));
  }

  const pushLine = debounce((lineId, field, value) => wsSend({ type: 'repairUpdateLine', lineId, field, value }), 200);
  const pushField = debounce((field, value) => wsSend({ type: 'repairUpdateField', field, value }), 200);

  // Live total updater — recomputes from current DOM without a full re-render,
  // so typing into a cost field updates the total instantly without losing focus.
  const updateLiveTotal = () => {
    const el = document.getElementById('repair-total');
    if (!el) return;
    const costs = [...document.querySelectorAll('input[data-cost]')].map(i => Number(i.value) || 0);
    const custom = Number(document.getElementById('custom-amount')?.value) || 0;
    const total = costs.reduce((s, v) => s + v, 0) + custom;
    el.textContent = fmtAUD(total);
  };

  const serviceRow = (line, idx) => {
    const variants = SERVICE_VARIANTS[line.service];

    const costInput = h('input', {
      type: 'number', min: '0', step: '0.01', inputmode: 'decimal',
      'data-cost': '1',
      placeholder: '0.00',
      value: line.cost || '',
      oninput: (e) => {
        updateLiveTotal();
        pushLine(line.id, 'cost', Number(e.target.value) || 0);
      },
    });

    const serviceSelect = h('select', {
      onchange: (e) => {
        const newService = e.target.value;
        // Local state update for immediate UI structure change (variant row show/hide)
        line.service = newService;
        line.variant = '';
        const fixed = SERVICE_PRICES[newService];
        if (typeof fixed === 'number') {
          line.cost = fixed;
        } else if (SERVICE_VARIANTS[newService]) {
          // Wait for user to pick a variant; leave cost as-is so they see the change.
          line.cost = 0;
        } else {
          line.cost = 0;
        }
        render();
        updateLiveTotal();
        // Sync to server: send service + variant reset + cost
        wsSend({ type: 'repairUpdateLine', lineId: line.id, field: 'service', value: newService });
        wsSend({ type: 'repairUpdateLine', lineId: line.id, field: 'variant', value: '' });
        wsSend({ type: 'repairUpdateLine', lineId: line.id, field: 'cost',    value: line.cost });
      },
    },
      h('option', { value: '' }, 'Select service…'),
      ...SERVICE_OPTIONS.map(s => h('option', { value: s, selected: s === line.service ? '' : undefined }, s)),
    );

    const variantRow = variants ? h('div', { class: 'field' },
      h('label', {}, 'Variant'),
      h('select', {
        onchange: (e) => {
          const v = e.target.value;
          const match = variants.find(x => x.label === v);
          line.variant = v;
          if (match) line.cost = match.price;
          render();
          updateLiveTotal();
          wsSend({ type: 'repairUpdateLine', lineId: line.id, field: 'variant', value: v });
          if (match) wsSend({ type: 'repairUpdateLine', lineId: line.id, field: 'cost', value: match.price });
        },
      },
        h('option', { value: '' }, 'Select variant…'),
        ...variants.map(v => h('option', { value: v.label, selected: v.label === line.variant ? '' : undefined },
          `${v.label} — ${fmtAUD(v.price)}`)),
      ),
    ) : null;

    return h('div', { class: 'svc-entry' },
      h('div', { class: 'svc-num' }, String(idx + 1)),
      r.lines.length > 1 ? h('button', {
        class: 'svc-remove',
        type: 'button',
        title: 'Remove',
        onclick: () => wsSend({ type: 'repairRemoveLine', lineId: line.id }),
      }, '×') : null,
      h('div', { class: 'svc-body' },
        h('div', { class: 'row-2' },
          h('div', { class: 'field' }, h('label', {}, 'Service'), serviceSelect),
          h('div', { class: 'field' }, h('label', {}, 'Cost (inc. GST)'), costInput),
        ),
        variantRow,
      ),
    );
  };

  const pickPayment = (type) => {
    r.paymentType = type;
    if (type !== 'deposit') r.depositAmount = 0;
    render();
    wsSend({ type: 'repairUpdateField', field: 'paymentType', value: type });
  };

  const resultBanner = lastRepairResult && !lastRepairResult.ok
    ? h('div', { class: 'result-banner err' },
        lastRepairResult.detail || `Error: ${lastRepairResult.error}`)
    : null;

  const name = job.customer.firstName || 'this customer';

  return h('div', {},
    h('h1', {}, 'Service & pricing'),
    h('p', { class: 'sub' }, `Add the services for ${name}'s repair. The customer screen updates live.`),

    h('div', { class: 'card' },
      h('div', { class: 'section-label' }, 'Device'),
      h('div', { class: 'field' },
        h('label', {}, 'Device model'),
        h('input', {
          type: 'text',
          placeholder: 'e.g. HP Envy x360 15-EY, MacBook Pro 14" M3…',
          autocomplete: 'off',
          value: r.deviceModel || '',
          oninput: (e) => pushField('deviceModel', e.target.value),
        }),
        h('div', { class: 'hint' }, 'Appears on the printed job receipt.'),
      ),
    ),

    h('div', { class: 'card' },
      h('div', { class: 'section-label' }, 'What are we doing?'),
      h('div', { class: 'stack' }, ...r.lines.map((l, i) => serviceRow(l, i))),
      h('button', {
        class: 'add-svc-btn',
        type: 'button',
        onclick: () => wsSend({ type: 'repairAddLine' }),
      }, h('span', { style: 'font-size:20px;line-height:1' }, '+'), ' Add another service'),
    ),

    h('div', { class: 'card' },
      h('div', { class: 'section-label' }, 'Job description'),
      h('div', { class: 'field' },
        h('label', {}, 'What work needs to be done?'),
        h('textarea', {
          placeholder: 'e.g. Windows 11 Reinstall + Setup + Driver install, Replace battery + test charging circuit…',
          style: 'min-height:80px',
          oninput: (e) => pushField('jobDescription', e.target.value),
        }, r.jobDescription || ''),
        h('div', { class: 'hint' }, 'This goes on the job card and the Xero invoice notes.'),
      ),
    ),

    h('div', { class: 'card' },
      h('div', { class: 'section-label' }, 'Custom / non-standard service'),
      h('div', { class: 'row-2' },
        h('div', { class: 'field' },
          h('label', {}, 'Service description'),
          h('input', {
            type: 'text',
            placeholder: 'e.g. Data recovery…',
            autocomplete: 'off',
            value: r.customServiceName || '',
            oninput: (e) => pushField('customServiceName', e.target.value),
          }),
        ),
        h('div', { class: 'field' },
          h('label', {}, 'Amount (inc. GST)'),
          h('input', {
            type: 'number', min: '0', step: '0.01', inputmode: 'decimal',
            id: 'custom-amount',
            placeholder: '0.00',
            value: r.customServiceAmount || '',
            oninput: (e) => {
              updateLiveTotal();
              pushField('customServiceAmount', Number(e.target.value) || 0);
            },
          }),
        ),
      ),
    ),

    h('div', { class: 'card' },
      h('div', { class: 'section-label' }, 'Payment'),
      h('div', { class: 'yn-toggle' },
        h('button', {
          type: 'button',
          class: `yn-btn ${r.paymentType === 'full' ? 'active' : ''}`,
          onclick: () => pickPayment('full'),
        }, 'Paying in full'),
        h('button', {
          type: 'button',
          class: `yn-btn ${r.paymentType === 'deposit' ? 'active' : ''}`,
          onclick: () => pickPayment('deposit'),
        }, 'Leaving a deposit'),
      ),
      r.paymentType === 'deposit' ? h('div', { class: 'field', style: 'margin-top:12px' },
        h('label', {}, 'Deposit amount'),
        h('input', {
          type: 'number', min: '0', step: '0.01', inputmode: 'decimal',
          placeholder: '0.00',
          value: r.depositAmount || '',
          oninput: (e) => pushField('depositAmount', Number(e.target.value) || 0),
        }),
      ) : null,
    ),

    h('div', { class: 'card' },
      h('div', { class: 'price-total' },
        h('span', { class: 'total-label' }, 'Total (inc. GST)'),
        h('span', { class: 'total-amount', id: 'repair-total' }, fmtAUD(computeRepairTotal(r))),
      ),
    ),

    signatureCard(job, 'drop_off'),

    resultBanner,

    h('div', { class: 'form-actions' },
      h('button', {
        class: 'btn btn-ghost',
        onclick: () => wsSend({ type: 'backToRouter' }),
      }, '← Back'),
      h('div', { class: 'spacer' }),
      h('button', {
        class: 'btn btn-primary',
        onclick: () => { lastRepairResult = null; wsSend({ type: 'submitRepair' }); },
      }, 'Next — Checkout →'),
    ),
  );
}

// ── Customer signature capture ─────────────────────────────────────────────
// Staff asks the customer to sign on their monitor. The server sets
// `signatureRequest` which the customer screen picks up via WS and shows a
// signature pad. The captured PNG lands back on `job.signatures[slot]`.

const SIGNATURE_LABELS = {
  drop_off: {
    title: 'Customer signature — authorisation to proceed',
    hint: 'Customer signs to confirm T&Cs and authorise the work. Appears on the job receipt.',
    askCta: 'Ask customer to sign',
    redoCta: 'Redo signature',
    waiting: 'Signature pad is open on the customer screen — waiting for them to sign…',
  },
  pick_up: {
    title: 'Customer signature — collection',
    hint: 'Customer signs to confirm the work was completed to their satisfaction.',
    askCta: 'Ask customer to sign',
    redoCta: 'Redo signature',
    waiting: 'Signature pad is open on the customer screen — waiting for them to sign…',
  },
};

function signatureSlot(kind) {
  return kind === 'drop_off' ? 'dropOff' : 'pickUp';
}

function fmtSignedAt(iso) {
  try {
    return new Date(iso).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' });
  } catch { return ''; }
}

function signatureCard(job, kind) {
  const copy = SIGNATURE_LABELS[kind];
  if (!copy) return null;
  const sig = job.signatures?.[signatureSlot(kind)] ?? null;
  const req = job.signatureRequest;
  const pending = req && req.kind === kind;

  let inner;
  if (sig) {
    inner = h('div', { class: 'sig-card-captured' },
      h('img', { class: 'sig-card-thumb', src: sig.dataUrl, alt: 'Captured signature' }),
      h('div', { class: 'sig-card-meta' },
        h('div', { class: 'sig-card-ok' }, '✓ Signed', sig.signedAt ? ` · ${fmtSignedAt(sig.signedAt)}` : ''),
        h('button', {
          class: 'btn btn-ghost btn-sm-top',
          type: 'button',
          style: 'margin-left:0',
          onclick: () => {
            wsSend({ type: 'clearSignature', kind });
            wsSend({ type: 'requestSignature', kind });
          },
        }, copy.redoCta),
      ),
    );
  } else if (pending) {
    inner = h('div', { class: 'sig-card-waiting' },
      h('div', { class: 'sig-card-spinner' }, '⏳'),
      h('div', { class: 'sig-card-waiting-text' }, copy.waiting),
      h('button', {
        class: 'btn btn-ghost btn-sm-top',
        type: 'button',
        style: 'margin-left:0',
        onclick: () => wsSend({ type: 'cancelSignatureRequest' }),
      }, 'Cancel'),
    );
  } else {
    inner = h('div', { class: 'sig-card-empty' },
      h('p', { class: 'hint', style: 'margin:0 0 10px' }, copy.hint),
      h('button', {
        class: 'btn btn-primary',
        type: 'button',
        onclick: () => wsSend({ type: 'requestSignature', kind }),
      }, copy.askCta),
    );
  }

  return h('div', { class: 'card sig-card-block' },
    h('div', { class: 'section-label' }, copy.title),
    inner,
  );
}

// ── Checkout flow ──────────────────────────────────────────────────────────
// Computes what's due *today*. Mirrors server-side amountDueToday() exactly so
// the staff screen can show the number without a round-trip.
function checkoutDueToday(job) {
  const r = job.repair, p = job.product, o = job.onTheSpot, pu = job.pickup;
  if (r) {
    const tot = computeRepairTotal(r);
    const isDep = r.paymentType === 'deposit';
    return { amount: isDep ? (Number(r.depositAmount) || 0) : tot, orderTotal: tot, isDeposit: isDep };
  }
  if (p) {
    const tot = computeProductTotal(p);
    const isDep = p.paymentType === 'deposit';
    return { amount: isDep ? (Number(p.depositAmount) || 0) : tot, orderTotal: tot, isDeposit: isDep };
  }
  if (o) {
    const tot = computeOnTheSpotTotal(o);
    const isDep = o.paymentType === 'deposit';
    return { amount: isDep ? (Number(o.depositAmount) || 0) : tot, orderTotal: tot, isDeposit: isDep };
  }
  if (pu) {
    const t = computePickupTotals(pu);
    return { amount: t.total, orderTotal: t.total, isDeposit: false, pickup: t };
  }
  return { amount: 0, orderTotal: 0, isDeposit: false };
}

// ── Computer-password reveal ─────────────────────────────────────────────
// Server stores the password AES-256-GCM encrypted; reveal is logged to
// data/password-reveals.json with the staff user, timestamp, and reason.

function fmtRelativeFromNow(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  const days = Math.round(ms / (24 * 60 * 60 * 1000));
  if (days > 1) return `expires in ${days} days`;
  if (days === 1) return 'expires tomorrow';
  if (days === 0) return 'expires today';
  return `expired ${-days} day${days === -1 ? '' : 's'} ago`;
}

async function fetchPasswordRecordsForContact(contactId) {
  const r = await fetch(`/api/password/for-contact/${encodeURIComponent(contactId)}`, {
    credentials: 'same-origin',
  });
  if (!r.ok) throw new Error(`lookup_failed (${r.status})`);
  return (await r.json()).records || [];
}

async function revealPasswordRequest(recordId, reason) {
  const r = await fetch(`/api/password/reveal/${encodeURIComponent(recordId)}`, {
    method: 'POST',
    credentials: 'same-origin',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ reason }),
  });
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.ok) throw new Error(body.error || `reveal_failed (${r.status})`);
  return body.plaintext;
}

function openPasswordRevealModal({ title, sub, records }) {
  document.getElementById('pwd-reveal-overlay')?.remove();

  if (!records.length) {
    alert('No computer password is stored for this customer.');
    return;
  }

  const cards = records.map((rec) => {
    const plaintextSlot = h('div', { class: 'plaintext', id: `pwd-pt-${rec.id}` }, '••••••••');
    const revealBtn = h('button', {
      class: 'btn btn-primary',
      disabled: rec.expired,
      onclick: async () => {
        const reason = prompt('Why are you accessing this password?\n\nThis is logged.');
        if (!reason || !reason.trim()) return;
        revealBtn.setAttribute('disabled', '');
        revealBtn.textContent = 'Revealing…';
        try {
          const plaintext = await revealPasswordRequest(rec.id, reason.trim());
          plaintextSlot.textContent = plaintext;
          revealBtn.textContent = 'Revealed';
        } catch (err) {
          revealBtn.removeAttribute('disabled');
          revealBtn.textContent = 'Retry';
          alert(`Could not reveal password: ${err.message}`);
        }
      },
    }, rec.expired ? 'Expired' : 'Reveal');

    return h('div', { class: `pwd-record-card${rec.expired ? ' expired' : ''}` },
      h('div', { class: 'meta' },
        `Saved ${new Date(rec.createdAt).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' })} by ${rec.createdBy?.name || 'unknown'} — ${fmtRelativeFromNow(rec.expiresAt)}`,
      ),
      plaintextSlot,
      rec.expired ? h('div', { class: 'expired-note' }, 'This record has been purged after 30 days.') : null,
      h('div', {}, revealBtn),
    );
  });

  const overlay = h('div', { class: 'preview-overlay open', id: 'pwd-reveal-overlay' },
    h('div', { class: 'preview-inner', style: 'max-width:560px' },
      h('div', { class: 'preview-toolbar' },
        h('span', {}, title || 'Computer password'),
        h('div', { class: 'preview-toolbar-actions' },
          h('button', {
            class: 'preview-close-btn',
            onclick: () => document.getElementById('pwd-reveal-overlay')?.remove(),
          }, 'Close'),
        ),
      ),
      h('div', { class: 'pwd-modal-body' },
        sub ? h('p', { class: 'sub' }, sub) : null,
        ...cards,
      ),
    ),
  );
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.append(overlay);
}

async function revealPasswordForActiveJob(job) {
  if (!job.passwordRecordId) return;
  try {
    // We only have the record id; fetch the single record via contact lookup
    // (contactId is set after submitStep1, which is also when the record is saved).
    const records = job.contactId
      ? await fetchPasswordRecordsForContact(job.contactId)
      : [];
    const match = records.find(r => r.id === job.passwordRecordId);
    openPasswordRevealModal({
      title: `Computer password for ${job.customer.firstName || 'customer'}`,
      sub: 'Reveal is logged with your name, the time, and the reason you enter.',
      records: match ? [match] : [],
    });
  } catch (err) {
    alert(`Could not load password record: ${err.message}`);
  }
}

async function revealPasswordForContact(contactId, customerLabel) {
  try {
    const records = await fetchPasswordRecordsForContact(contactId);
    openPasswordRevealModal({
      title: `Computer password for ${customerLabel || 'customer'}`,
      sub: 'Reveal is logged with your name, the time, and the reason you enter.',
      records,
    });
  } catch (err) {
    alert(`Could not load password records: ${err.message}`);
  }
}

function checkoutFlowLabel(job) {
  if (job.repair) return 'Repair';
  if (job.product) return 'Product';
  if (job.onTheSpot) return 'Quick fix';
  if (job.pickup) return 'Pickup';
  return 'Job';
}

// ── Receipt preview ─────────────────────────────────────────────────────
// Builds the same A4 receipt that gets saved to the job card at checkout.
// Ported from job-intake-form.html so staff can eyeball it before taking
// payment. Fields the POS doesn't yet collect (device/peripherals) render
// as blank rows to preserve the printed layout.

function receiptServicesText(job) {
  const r = job.repair, p = job.product, o = job.onTheSpot, pu = job.pickup;
  const parts = [];
  if (r) {
    for (const l of r.lines) {
      if (!l.service) continue;
      parts.push(`${l.service}${l.variant ? ` — ${l.variant}` : ''} (${fmtAUD(l.cost)})`);
    }
    if (r.customServiceName.trim() && (Number(r.customServiceAmount) || 0) > 0) {
      parts.push(`${r.customServiceName.trim()} (${fmtAUD(r.customServiceAmount)})`);
    }
  } else if (p) {
    for (const l of p.lines) {
      if (!l.name.trim()) continue;
      const qty = Number(l.qty) || 0;
      parts.push(`${qty}× ${l.name.trim()} @ ${fmtAUD(l.unitPrice)}`);
    }
  } else if (o) {
    if ((Number(o.price) || 0) > 0) parts.push(`${o.description || 'Quick fix'} (${fmtAUD(o.price)})`);
    if ((Number(o.hours) || 0) > 0) parts.push(`Labour — ${o.hours} hr${o.hours === 1 ? '' : 's'} @ ${fmtAUD(o.hourlyRate)}/hr`);
  } else if (pu) {
    const t = computePickupTotals(pu);
    if (t.inv) parts.push(`Balance on ${t.inv.invoiceNumber}: ${fmtAUD(t.invoiceDue)}`);
    for (const l of pu.extraLines) {
      if (!l.description.trim() && !(Number(l.amount) || 0)) continue;
      parts.push(`${l.description.trim() || 'Extra'} (${fmtAUD(l.amount)})`);
    }
  }
  return parts.join(' • ');
}

function receiptJobDescription(job) {
  if (job.repair) return job.repair.jobDescription || '';
  if (job.product) return job.product.notes || '';
  if (job.onTheSpot) return [job.onTheSpot.description, job.onTheSpot.notes].filter(Boolean).join(' — ');
  if (job.pickup) return job.pickup.extraNotes || '';
  return '';
}

function receiptTotals(job) {
  const due = checkoutDueToday(job);
  const r = job.repair, p = job.product, o = job.onTheSpot;
  let deposit = 0;
  if (r) deposit = r.paymentType === 'deposit' ? (Number(r.depositAmount) || 0) : 0;
  else if (p) deposit = p.paymentType === 'deposit' ? (Number(p.depositAmount) || 0) : 0;
  else if (o) deposit = o.paymentType === 'deposit' ? (Number(o.depositAmount) || 0) : 0;
  // If checkout already succeeded, reflect what was actually paid.
  if (job.checkout?.receipt) {
    const paid = Number(job.checkout.receipt.amountPaid) || 0;
    if (paid > 0) deposit = paid;
  }
  const total = Number(due.orderTotal) || 0;
  const balance = Math.max(0, total - deposit);
  return { total, deposit, balance };
}

function receiptInvoiceNumbers(job) {
  const nums = job.checkout?.receipt?.invoiceNumbers;
  if (Array.isArray(nums) && nums.length) return nums.join(', ');
  if (job.pickup) {
    const t = computePickupTotals(job.pickup);
    if (t.inv) return t.inv.invoiceNumber;
  }
  return '';
}

function receiptDeviceStatus(job) {
  // Best-effort inference — we'll surface a real field when we add one.
  if (job.pickup) return 'Ready for pickup';
  if (job.onTheSpot) return 'Completed on-the-spot';
  if (job.product) return 'Product sale — no device';
  if (job.repair) {
    const pt = job.repair.paymentType;
    return pt === 'deposit' ? 'Booked in (deposit taken)' : 'Booked in';
  }
  return '';
}

function receiptDateStr(job) {
  try {
    return new Date(job.startedAt).toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return ''; }
}

function receiptJobNum(job) {
  // Prefer the human-friendly sequential displayNumber (#1051…). Fall back
  // to the last 6 chars of the opaque job id for jobs started before the
  // counter existed (so old receipts still render something sensible).
  if (job?.displayNumber != null) return String(job.displayNumber);
  return (job?.id || '').slice(-6).toUpperCase();
}

function buildReceiptEl(job) {
  const name = [job.customer.firstName, job.customer.lastName].filter(Boolean).join(' ');
  const jobNum = receiptJobNum(job);
  const totals = receiptTotals(job);
  const services = receiptServicesText(job);
  const jobDesc = receiptJobDescription(job);
  const invoice = receiptInvoiceNumbers(job);
  const devStatus = receiptDeviceStatus(job);
  const dateStr = receiptDateStr(job);
  const servedBy = job.startedBy?.name || '';

  const row = (label, val, { full = false } = {}) => h('div', { class: `rinfo-row${full ? ' full' : ''}` },
    h('span', { class: 'rinfo-label' }, label),
    h('span', { class: 'rinfo-val' }, val || ''),
  );
  const rowStrong = (label, val) => h('div', { class: 'rinfo-row' },
    h('span', { class: 'rinfo-label' }, label),
    h('span', { class: 'rinfo-val', style: 'font-weight:bold' }, val || ''),
  );

  return h('div', { class: 'receipt' },
    h('div', { class: 'rh' },
      h('img', { class: 'rh-logo', src: '/assets/logo.jpg', alt: 'Computer Mechanics' }),
      h('div', { class: 'rh-right' },
        h('div', { class: 'rh-title' }, 'Service Number'),
        h('div', { class: 'rh-num' }, `#${jobNum}`),
      ),
    ),

    h('div', { class: 'rinfo' },
      h('div', { class: 'rinfo-section' }, 'Customer & Job Details'),
      row('Name:', name),
      row('Email:', job.customer.email),
      row('Phone:', job.customer.phone),
      row('Postcode:', job.customer.postcode),
      row('Company:', job.customer.company),
      row('Booked in by:', servedBy),

      h('div', { class: 'rinfo-section' }, 'Device'),
      row('Device:', job.repair?.deviceModel || ''),
      row('Items Taken:', ''),
      row('Date:', dateStr),
      row('Issues:', '', { full: true }),
      job.customer.hasComputerPassword && job.customer.computerPassword
        ? row('Computer password:', job.customer.computerPassword)
        : null,

      h('div', { class: 'rinfo-section' }, 'Pricing'),
      row('Services:', services, { full: true }),
      row('Job Description:', jobDesc, { full: true }),
      rowStrong('Total:', fmtAUD(totals.total)),
      row('Deposit Paid:', fmtAUD(totals.deposit)),
      rowStrong('Balance Due:', fmtAUD(totals.balance)),
      row('Invoice #:', invoice),
      row('Device Status:', devStatus),
    ),

    h('div', { class: 'rproblem-label' }, 'Problem description:'),
    h('div', { class: 'rproblem-box' }, jobDesc),

    h('div', { class: 'rconsent' },
      'I, the undersigned have read and agreed to the terms and conditions listed below. I hereby give authority to Computer Mechanics to proceed with the service requested above and agree to the terms listed below.',
    ),
    receiptSignatureRow(job, 'drop_off'),
    h('div', { class: 'rconsent' }, 'I, the undersigned am satisfied that the above work has been completed as requested.'),
    receiptSignatureRow(job, 'pick_up'),

    h('div', { class: 'rpricing', style: 'border-bottom:1.5px solid #000;margin-bottom:7px;' },
      h('div', { class: 'rprice-cell rprice-cell-head', style: 'flex:0 0 auto;padding:5px 10px;' },
        h('div', { class: 'rprice-label', style: 'color:#fff;' }, 'Standard Charges'),
      ),
      h('div', { class: 'rprice-cell' },
        h('div', { class: 'rprice-label', style: 'color:#000;' }, 'Inspection Fee'),
        h('div', { class: 'rprice-amount' }, '$85.00'),
        h('div', { class: 'rprice-gst' }, 'inc. GST'),
      ),
      h('div', { class: 'rprice-cell' },
        h('div', { class: 'rprice-label', style: 'color:#000;' }, 'Fixed Charge'),
        h('div', { class: 'rprice-amount' }, '$175.00'),
        h('div', { class: 'rprice-gst' }, 'inc. GST'),
      ),
    ),

    h('div', { class: 'rfooter' },
      h('span', {}, 'Computer Mechanics — Telephone (08) 9325 1196'),
      h('span', {}, `Service #${jobNum}  |  ${name}`),
    ),

    h('div', { class: 'rtc-title' }, 'Terms & Conditions of Service'),
    receiptTermsEl(),
  );
}

// Build one consent-signature row on the receipt. If a signature was captured
// on the customer monitor, render it as an image across the line (and fill the
// name/date). Otherwise leave the original blank lines for pen-on-paper.
function receiptSignatureRow(job, kind) {
  const slot = kind === 'drop_off' ? 'dropOff' : 'pickUp';
  const sig = job.signatures?.[slot] ?? null;
  const name = [job.customer?.firstName, job.customer?.lastName].filter(Boolean).join(' ');
  let dateStr = '';
  if (sig?.signedAt) {
    try {
      dateStr = new Date(sig.signedAt).toLocaleDateString('en-AU', {
        day: 'numeric', month: 'short', year: 'numeric',
      });
    } catch { /* ignore */ }
  }

  if (sig) {
    return h('div', { class: 'rsig-row' },
      h('div', { class: 'rsig-item' },
        'Signature: ',
        h('span', { class: 'rsig-line rsig-lg rsig-signed' },
          h('img', { class: 'rsig-img', src: sig.dataUrl, alt: 'Customer signature' }),
        ),
      ),
      h('div', { class: 'rsig-item' },
        'Print Name: ',
        h('span', { class: 'rsig-line rsig-md rsig-filled' }, name),
      ),
      h('div', { class: 'rsig-item' },
        'Date: ',
        h('span', { class: 'rsig-line rsig-sm rsig-filled' }, dateStr),
      ),
    );
  }
  return h('div', { class: 'rsig-row' },
    h('div', { class: 'rsig-item' }, 'Signature: ', h('span', { class: 'rsig-line rsig-lg' })),
    h('div', { class: 'rsig-item' }, 'Print Name: ', h('span', { class: 'rsig-line rsig-md' })),
    h('div', { class: 'rsig-item' }, 'Date: ', h('span', { class: 'rsig-line rsig-sm' })),
  );
}

function receiptTermsEl() {
  const items = [
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
  return h('div', { class: 'rtc-body' },
    h('p', { style: 'margin:0 0 2px;' }, 'The client acknowledges that:'),
    h('ol', {}, ...items.map(t => h('li', {}, t))),
  );
}

function openReceiptPreview(job) {
  // Remove any existing preview first (re-opening).
  document.getElementById('receipt-preview-overlay')?.remove();

  const receiptEl = buildReceiptEl(job);
  const jobNum = receiptJobNum(job);

  const overlay = h('div', { class: 'preview-overlay open', id: 'receipt-preview-overlay' },
    h('div', { class: 'preview-inner' },
      h('div', { class: 'preview-toolbar' },
        h('span', {}, `Receipt preview — Service #${jobNum}`),
        h('div', { class: 'preview-toolbar-actions' },
          h('button', {
            class: 'preview-close-btn',
            onclick: () => document.getElementById('receipt-preview-overlay')?.remove(),
          }, 'Close'),
          h('button', {
            class: 'preview-print-btn',
            onclick: () => printReceipt(job),
          }, 'Print'),
        ),
      ),
      h('div', { class: 'preview-body' }, receiptEl),
    ),
  );
  // Click-outside-to-close.
  overlay.addEventListener('click', (e) => { if (e.target === overlay) overlay.remove(); });
  document.body.append(overlay);
}

function printReceipt(job) {
  // Build a standalone receipt wrapper, print, then clean up.
  const root = document.createElement('div');
  root.className = 'receipt-print-root';
  root.append(buildReceiptEl(job));
  document.body.append(root);
  const cleanup = () => { root.remove(); window.removeEventListener('afterprint', cleanup); };
  window.addEventListener('afterprint', cleanup);
  window.print();
}

function viewCheckout(job) {
  const c = job.checkout || { state: 'choosing', method: null, cashTendered: 0, declineReason: null, error: null, receipt: null };
  const due = checkoutDueToday(job);
  const name = [job.customer.firstName, job.customer.lastName].filter(Boolean).join(' ') || 'Customer';
  const label = checkoutFlowLabel(job);

  // Common back-to-editing pill for the choosing / error states.
  const backToEdit = h('button', {
    class: 'btn btn-ghost',
    onclick: () => wsSend({ type: 'backFromCheckout' }),
  }, '← Back to edit');

  // ── State: done (success) ────────────────────────────────────────────────
  if (c.state === 'done') {
    const r = c.receipt || {};
    const method = r.method || c.method;
    const amount = Number(r.amountPaid) || 0;
    const inv = (r.invoiceNumbers || []).join(', ');

    const paidLine = method === 'pay_later'
      ? h('p', { class: 'sub' }, `Invoice emailed to ${job.customer.email || 'customer'} — pay later.`)
      : method === 'cash'
        ? h('p', { class: 'sub' }, `Cash received: ${fmtAUD(amount)}${r.cashTendered ? ` (tendered ${fmtAUD(r.cashTendered)}, change ${fmtAUD(r.changeGiven || 0)})` : ''}.`)
        : h('p', { class: 'sub' }, `Card approved: ${fmtAUD(amount)}${r.cardType ? ` — ${r.cardType}${r.cardLastFour ? ` •••• ${r.cardLastFour}` : ''}` : ''}.`);

    return h('div', { class: 'card placeholder-card' },
      h('div', { class: 'icon' }, '✅'),
      h('h1', {}, method === 'pay_later' ? 'Invoice sent' : 'Payment received'),
      paidLine,
      inv ? h('p', { class: 'muted' }, `Invoice ${inv} emailed${job.customer.email ? ` to ${job.customer.email}` : ''}.`) : null,
      r.reviewEmailScheduledAt
        ? h('p', { class: 'muted' }, `Google review request scheduled for ${new Date(r.reviewEmailScheduledAt).toLocaleTimeString('en-AU', { hour: 'numeric', minute: '2-digit' })}.`)
        : null,
      h('div', { class: 'form-actions', style: 'max-width:560px;margin:32px auto 0' },
        h('button', {
          class: 'btn btn-ghost',
          onclick: () => { if (confirm('Clear this job and return to dashboard?')) wsSend({ type: 'clearJob' }); },
        }, 'Finish — clear job'),
        h('div', { class: 'spacer' }),
        h('button', {
          class: 'btn btn-ghost',
          onclick: () => openReceiptPreview(job),
        }, 'Preview receipt'),
        h('button', {
          class: 'btn btn-primary',
          onclick: () => {
            lastStep1Result = null;
            lastRepairResult = null;
            lastProductResult = null;
            lastOnTheSpotResult = null;
            lastPickupResult = null;
            wsSend({ type: 'newJob' });
          },
        }, 'Start another job →'),
      ),
    );
  }

  // ── State: error (after all retries) ─────────────────────────────────────
  if (c.state === 'error') {
    return h('div', { class: 'card placeholder-card' },
      h('div', { class: 'icon' }, '⚠️'),
      h('h1', {}, 'Something went wrong'),
      h('p', { class: 'sub' }, c.error || 'The checkout could not be finalised.'),
      h('div', { class: 'form-actions', style: 'max-width:520px;margin:32px auto 0' },
        h('button', {
          class: 'btn btn-ghost',
          onclick: () => wsSend({ type: 'checkoutResetMethod' }),
        }, '← Try again'),
        h('div', { class: 'spacer' }),
        backToEdit,
      ),
    );
  }

  // ── State: card_charging (tyro in flight) ────────────────────────────────
  if (c.state === 'card_charging') {
    return h('div', { class: 'card placeholder-card' },
      h('div', { class: 'icon' }, '💳'),
      h('h1', {}, `Charging ${fmtAUD(due.amount)}`),
      h('p', { class: 'sub' }, 'Hand the terminal to the customer. This screen will update when the transaction completes.'),
      h('p', { class: 'muted' }, 'Waiting for Tyro…'),
    );
  }

  // ── State: card_declined ────────────────────────────────────────────────
  if (c.state === 'card_declined') {
    return h('div', {},
      h('h1', {}, 'Card declined'),
      h('p', { class: 'sub' }, `The terminal reported: ${c.declineReason || 'declined'}.`),
      h('div', { class: 'card' },
        h('div', { class: 'price-total' },
          h('span', { class: 'total-label' }, 'Amount to charge'),
          h('span', { class: 'total-amount' }, fmtAUD(due.amount)),
        ),
      ),
      h('div', { class: 'form-actions' },
        h('button', {
          class: 'btn btn-ghost',
          onclick: () => wsSend({ type: 'checkoutResetMethod' }),
        }, '← Switch method'),
        h('div', { class: 'spacer' }),
        h('button', {
          class: 'btn btn-primary',
          onclick: () => {
            // Server guard requires state === 'card_charging' to charge. Pick card again, then charge.
            wsSend({ type: 'checkoutPickMethod', method: 'card' });
            wsSend({ type: 'checkoutChargeCard' });
          },
        }, 'Retry card'),
      ),
    );
  }

  // ── State: processing (confirm in flight) ────────────────────────────────
  if (c.state === 'processing') {
    const label = c.method === 'pay_later' ? 'Emailing invoice…' : 'Recording payment…';
    return h('div', { class: 'card placeholder-card' },
      h('div', { class: 'icon' }, '⏳'),
      h('h1', {}, label),
      h('p', { class: 'sub' }, 'Creating Xero invoice, saving PDFs to the job card, sending email.'),
    );
  }

  // ── State: cash_entry ───────────────────────────────────────────────────
  if (c.state === 'cash_entry') {
    const dueAmount = due.amount;
    const presets = [dueAmount, Math.ceil(dueAmount / 10) * 10, Math.ceil(dueAmount / 20) * 20, Math.ceil(dueAmount / 50) * 50, Math.ceil(dueAmount / 100) * 100]
      .filter((v, i, arr) => v > 0 && arr.indexOf(v) === i); // unique, drop zeros

    const updateCashLive = () => {
      const input = document.getElementById('cash-tendered');
      const changeEl = document.getElementById('cash-change');
      const confirmBtn = document.getElementById('cash-confirm');
      if (!input || !changeEl || !confirmBtn) return;
      const tendered = Number(input.value) || 0;
      const change = tendered - dueAmount;
      changeEl.textContent = fmtAUD(Math.max(0, change));
      changeEl.classList.toggle('muted', tendered < dueAmount);
      if (tendered >= dueAmount) confirmBtn.removeAttribute('disabled');
      else confirmBtn.setAttribute('disabled', '');
    };

    const setTender = (v) => {
      const input = document.getElementById('cash-tendered');
      if (input) input.value = String(v);
      updateCashLive();
      wsSend({ type: 'checkoutUpdateTendered', value: v });
    };

    return h('div', {},
      h('h1', {}, 'Cash payment'),
      h('p', { class: 'sub' }, `${name} is paying ${fmtAUD(dueAmount)} in cash.`),

      h('div', { class: 'card' },
        h('div', { class: 'price-total' },
          h('span', { class: 'total-label' }, 'Amount due'),
          h('span', { class: 'total-amount' }, fmtAUD(dueAmount)),
        ),
      ),

      h('div', { class: 'card' },
        h('div', { class: 'section-label' }, 'Amount tendered'),
        h('div', { class: 'field' },
          h('input', {
            type: 'number', min: '0', step: '0.01', inputmode: 'decimal',
            id: 'cash-tendered',
            placeholder: '0.00',
            value: c.cashTendered || '',
            autofocus: true,
            oninput: (e) => {
              updateCashLive();
              wsSend({ type: 'checkoutUpdateTendered', value: Number(e.target.value) || 0 });
            },
          }),
        ),
        presets.length ? h('div', { class: 'quick-chips', style: 'margin-top:10px' },
          ...presets.map(v => h('button', {
            type: 'button',
            class: 'quick-chip',
            onclick: () => setTender(v),
          },
            h('span', { class: 'chip-label' }, v === dueAmount ? 'Exact' : fmtAUD(v)),
          )),
        ) : null,
      ),

      h('div', { class: 'card' },
        h('div', { class: 'price-total' },
          h('span', { class: 'total-label' }, 'Change due'),
          h('span', {
            class: `total-amount ${(Number(c.cashTendered) || 0) < dueAmount ? 'muted' : ''}`,
            id: 'cash-change',
          }, fmtAUD(Math.max(0, (Number(c.cashTendered) || 0) - dueAmount))),
        ),
      ),

      h('div', { class: 'form-actions' },
        h('button', {
          class: 'btn btn-ghost',
          onclick: () => wsSend({ type: 'checkoutResetMethod' }),
        }, '← Switch method'),
        h('div', { class: 'spacer' }),
        h('button', {
          class: 'btn btn-primary',
          id: 'cash-confirm',
          disabled: (Number(c.cashTendered) || 0) < dueAmount,
          onclick: () => wsSend({ type: 'checkoutConfirmCash' }),
        }, 'Confirm — cash received'),
      ),
    );
  }

  // ── State: choosing (default) ────────────────────────────────────────────
  const summaryRows = [];
  summaryRows.push({ label: `${label} total`, value: fmtAUD(due.orderTotal) });
  if (due.pickup) {
    if (due.pickup.extrasTotal > 0) {
      summaryRows.push({ label: `Balance on ${due.pickup.inv?.invoiceNumber}`, value: fmtAUD(due.pickup.invoiceDue) });
      summaryRows.push({ label: 'Extra charges (new invoice)', value: fmtAUD(due.pickup.extrasTotal) });
    }
  } else if (due.isDeposit) {
    summaryRows.push({ label: 'Deposit due today', value: fmtAUD(due.amount), strong: true });
    summaryRows.push({ label: 'Balance remaining', value: fmtAUD(Math.max(0, due.orderTotal - due.amount)), muted: true });
  }

  const payLaterDisabled = due.amount <= 0;

  return h('div', {},
    h('h1', {}, 'Checkout'),
    h('p', { class: 'sub' }, `${name} — how are they paying?`),

    h('div', { class: 'card' },
      h('div', { class: 'pickup-rows' },
        ...summaryRows.map(row => h('div', { class: `row${row.strong ? ' strong' : ''}` },
          h('div', { class: 'label' }, row.label),
          h('div', { class: `value${row.muted ? ' muted' : ''}` }, row.value),
        )),
      ),
      h('div', { class: 'invoice-meta' },
        h('div', { class: 'row strong' },
          h('div', { class: 'label' }, 'Due today'),
          h('div', { class: 'value' }, fmtAUD(due.amount)),
        ),
      ),
    ),

    h('div', { class: 'card' },
      h('div', { class: 'section-label' }, 'Payment method'),
      h('div', { class: 'method-grid' },
        h('button', {
          type: 'button',
          class: 'method-tile',
          onclick: () => {
            // Tell server to transition to card_charging, then immediately tell
            // it to start the Tyro charge. Server processes these in order.
            wsSend({ type: 'checkoutPickMethod', method: 'card' });
            wsSend({ type: 'checkoutChargeCard' });
          },
        },
          h('div', { class: 'method-icon' }, '💳'),
          h('div', { class: 'method-title' }, 'Card'),
          h('div', { class: 'method-sub' }, 'Charge on the Tyro terminal'),
        ),
        h('button', {
          type: 'button',
          class: 'method-tile',
          onclick: () => wsSend({ type: 'checkoutPickMethod', method: 'cash' }),
        },
          h('div', { class: 'method-icon' }, '💵'),
          h('div', { class: 'method-title' }, 'Cash'),
          h('div', { class: 'method-sub' }, 'Amount tendered → change due'),
        ),
        h('button', {
          type: 'button',
          class: 'method-tile',
          disabled: payLaterDisabled,
          onclick: () => { if (!payLaterDisabled) wsSend({ type: 'checkoutPickMethod', method: 'pay_later' }); },
        },
          h('div', { class: 'method-icon' }, '📧'),
          h('div', { class: 'method-title' }, 'Pay later'),
          h('div', { class: 'method-sub' }, payLaterDisabled ? 'Nothing due today' : 'Email invoice, no payment today'),
        ),
      ),
    ),

    h('div', { class: 'form-actions' },
      backToEdit,
      h('div', { class: 'spacer' }),
      h('button', {
        class: 'btn btn-ghost',
        onclick: () => openReceiptPreview(job),
      }, 'Preview receipt'),
      h('button', {
        class: 'btn btn-ghost',
        onclick: () => { if (confirm('Cancel and clear this job?')) wsSend({ type: 'clearJob' }); },
      }, 'Cancel job'),
    ),
  );
}

// ── Product flow ───────────────────────────────────────────────────────────
function computeProductTotal(p) {
  if (!p) return 0;
  return p.lines.reduce((s, l) => s + (Number(l.qty) || 0) * (Number(l.unitPrice) || 0), 0);
}

function viewProduct(job) {
  const p = job.product;
  if (!p) {
    return h('div', { class: 'card' }, h('p', {}, 'Loading product state…'));
  }

  const pushLine = debounce((lineId, field, value) => wsSend({ type: 'productUpdateLine', lineId, field, value }), 200);
  const pushField = debounce((field, value) => wsSend({ type: 'productUpdateField', field, value }), 200);

  const updateLiveTotal = () => {
    const el = document.getElementById('product-total');
    if (!el) return;
    const rows = [...document.querySelectorAll('[data-product-row]')];
    const total = rows.reduce((s, row) => {
      const qty = Number(row.querySelector('[data-product-qty]')?.value) || 0;
      const price = Number(row.querySelector('[data-product-price]')?.value) || 0;
      // Also paint per-line total into its cell
      const lineTotalEl = row.querySelector('[data-product-linetotal]');
      if (lineTotalEl) lineTotalEl.textContent = fmtAUD(qty * price);
      return s + qty * price;
    }, 0);
    el.textContent = fmtAUD(total);
  };

  const productRow = (line, idx) => {
    return h('div', { class: 'svc-entry', 'data-product-row': '1' },
      h('div', { class: 'svc-num' }, String(idx + 1)),
      p.lines.length > 1 ? h('button', {
        class: 'svc-remove',
        type: 'button',
        title: 'Remove',
        onclick: () => wsSend({ type: 'productRemoveLine', lineId: line.id }),
      }, '×') : null,
      h('div', { class: 'svc-body' },
        h('div', { class: 'field' },
          h('label', {}, 'Product or item'),
          h('input', {
            type: 'text',
            placeholder: 'e.g. 1TB NVMe SSD, USB-C charger…',
            autocomplete: 'off',
            value: line.name || '',
            oninput: (e) => pushLine(line.id, 'name', e.target.value),
          }),
        ),
        h('div', { class: 'product-row-3' },
          h('div', { class: 'field' },
            h('label', {}, 'Qty'),
            h('input', {
              type: 'number', min: '1', step: '1', inputmode: 'numeric',
              'data-product-qty': '1',
              value: line.qty || 1,
              oninput: (e) => { updateLiveTotal(); pushLine(line.id, 'qty', Number(e.target.value) || 0); },
            }),
          ),
          h('div', { class: 'field' },
            h('label', {}, 'Unit price (inc. GST)'),
            h('input', {
              type: 'number', min: '0', step: '0.01', inputmode: 'decimal',
              'data-product-price': '1',
              placeholder: '0.00',
              value: line.unitPrice || '',
              oninput: (e) => { updateLiveTotal(); pushLine(line.id, 'unitPrice', Number(e.target.value) || 0); },
            }),
          ),
          h('div', { class: 'field' },
            h('label', {}, 'Line total'),
            h('div', {
              class: 'line-total',
              'data-product-linetotal': '1',
            }, fmtAUD((Number(line.qty) || 0) * (Number(line.unitPrice) || 0))),
          ),
        ),
      ),
    );
  };

  const pickPayment = (type) => {
    p.paymentType = type;
    if (type !== 'deposit') p.depositAmount = 0;
    render();
    wsSend({ type: 'productUpdateField', field: 'paymentType', value: type });
  };

  const resultBanner = lastProductResult && !lastProductResult.ok
    ? h('div', { class: 'result-banner err' },
        lastProductResult.detail || `Error: ${lastProductResult.error}`)
    : null;

  const name = job.customer.firstName || 'this customer';

  return h('div', {},
    h('h1', {}, 'Products'),
    h('p', { class: 'sub' }, `Add what ${name} is buying. The customer screen updates live.`),

    h('div', { class: 'card' },
      h('div', { class: 'section-label' }, 'Items'),
      h('div', { class: 'stack' }, ...p.lines.map((l, i) => productRow(l, i))),
      h('button', {
        class: 'add-svc-btn',
        type: 'button',
        onclick: () => wsSend({ type: 'productAddLine' }),
      }, h('span', { style: 'font-size:20px;line-height:1' }, '+'), ' Add another item'),
    ),

    h('div', { class: 'card' },
      h('div', { class: 'section-label' }, 'Notes (optional)'),
      h('div', { class: 'field' },
        h('label', {}, 'Anything to remember about this sale?'),
        h('textarea', {
          placeholder: 'e.g. Keep original packaging for return within 30 days…',
          style: 'min-height:60px',
          oninput: (e) => pushField('notes', e.target.value),
        }, p.notes || ''),
      ),
    ),

    h('div', { class: 'card' },
      h('div', { class: 'section-label' }, 'Payment'),
      h('div', { class: 'yn-toggle' },
        h('button', {
          type: 'button',
          class: `yn-btn ${p.paymentType === 'full' ? 'active' : ''}`,
          onclick: () => pickPayment('full'),
        }, 'Paying in full'),
        h('button', {
          type: 'button',
          class: `yn-btn ${p.paymentType === 'deposit' ? 'active' : ''}`,
          onclick: () => pickPayment('deposit'),
        }, 'Leaving a deposit'),
      ),
      p.paymentType === 'deposit' ? h('div', { class: 'field', style: 'margin-top:12px' },
        h('label', {}, 'Deposit amount'),
        h('input', {
          type: 'number', min: '0', step: '0.01', inputmode: 'decimal',
          placeholder: '0.00',
          value: p.depositAmount || '',
          oninput: (e) => pushField('depositAmount', Number(e.target.value) || 0),
        }),
      ) : null,
    ),

    h('div', { class: 'card' },
      h('div', { class: 'price-total' },
        h('span', { class: 'total-label' }, 'Total (inc. GST)'),
        h('span', { class: 'total-amount', id: 'product-total' }, fmtAUD(computeProductTotal(p))),
      ),
    ),

    signatureCard(job, 'drop_off'),

    resultBanner,

    h('div', { class: 'form-actions' },
      h('button', {
        class: 'btn btn-ghost',
        onclick: () => wsSend({ type: 'backToRouter' }),
      }, '← Back'),
      h('div', { class: 'spacer' }),
      h('button', {
        class: 'btn btn-primary',
        onclick: () => { lastProductResult = null; wsSend({ type: 'submitProduct' }); },
      }, 'Next — Checkout →'),
    ),
  );
}
// ── On-the-spot flow ───────────────────────────────────────────────────────
// Quick-fix chips — one-tap fill of description + price for common jobs.
const QUICK_FIXES = [
  { desc: 'Password reset',       price: 175 },
  { desc: 'Quick diagnostic',     price: 85  },
  { desc: 'Software install',     price: 90  },
  { desc: 'Driver install',       price: 100 },
  { desc: 'Virus / malware scan', price: 85  },
];

// Hours the tech might have logged. 0 = no hourly charge.
const HOUR_OPTIONS = [
  { value: 0,    label: 'No hourly charge' },
  { value: 0.25, label: '15 min' },
  { value: 0.5,  label: '30 min' },
  { value: 0.75, label: '45 min' },
  { value: 1,    label: '1 hour' },
  { value: 1.5,  label: '1.5 hours' },
  { value: 2,    label: '2 hours' },
  { value: 2.5,  label: '2.5 hours' },
  { value: 3,    label: '3 hours' },
  { value: 4,    label: '4 hours' },
  { value: 5,    label: '5 hours' },
  { value: 6,    label: '6 hours' },
  { value: 8,    label: '8 hours' },
];

function computeOnTheSpotTotal(o) {
  if (!o) return 0;
  return (Number(o.price) || 0) + (Number(o.hours) || 0) * (Number(o.hourlyRate) || 0);
}

function viewOnTheSpot(job) {
  const o = job.onTheSpot;
  if (!o) {
    return h('div', { class: 'card' }, h('p', {}, 'Loading on-the-spot state…'));
  }

  const pushField = debounce((field, value) => wsSend({ type: 'onTheSpotUpdateField', field, value }), 200);

  // Always read fresh from job.onTheSpot inside handlers — the in-place state
  // merge keeps identity stable, so `job.onTheSpot` is always the live object.
  const updateLiveTotal = () => {
    const el = document.getElementById('ots-total');
    const hEl = document.getElementById('ots-hours-total');
    const price = Number(document.getElementById('ots-price')?.value) || 0;
    const hours = Number(job.onTheSpot.hours) || 0;
    const rate  = Number(job.onTheSpot.hourlyRate) || 0;
    if (hEl) hEl.textContent = fmtAUD(hours * rate);
    if (el)  el.textContent  = fmtAUD(price + hours * rate);
  };

  const applyQuickFix = (chip) => {
    const ot = job.onTheSpot;
    ot.description = chip.desc;
    ot.price = chip.price;
    render();
    wsSend({ type: 'onTheSpotUpdateField', field: 'description', value: chip.desc });
    wsSend({ type: 'onTheSpotUpdateField', field: 'price',       value: chip.price });
  };

  const pickHours = (hours) => {
    const ot = job.onTheSpot;
    ot.hours = hours;
    render();
    wsSend({ type: 'onTheSpotUpdateField', field: 'hours', value: hours });
  };

  const pickPayment = (type) => {
    const ot = job.onTheSpot;
    ot.paymentType = type;
    if (type !== 'deposit') ot.depositAmount = 0;
    render();
    wsSend({ type: 'onTheSpotUpdateField', field: 'paymentType', value: type });
  };

  const resultBanner = lastOnTheSpotResult && !lastOnTheSpotResult.ok
    ? h('div', { class: 'result-banner err' },
        lastOnTheSpotResult.detail || `Error: ${lastOnTheSpotResult.error}`)
    : null;

  const name = job.customer.firstName || 'this customer';
  const rate = Number(o.hourlyRate) || 175;

  return h('div', {},
    h('h1', {}, 'Quick fix'),
    h('p', { class: 'sub' }, `What are we doing for ${name} right now?`),

    h('div', { class: 'card' },
      h('div', { class: 'section-label' }, 'Common quick fixes'),
      h('div', { class: 'quick-chips' },
        ...QUICK_FIXES.map(chip => h('button', {
          type: 'button',
          class: `quick-chip ${o.description === chip.desc ? 'active' : ''}`,
          onclick: () => applyQuickFix(chip),
        },
          h('span', { class: 'chip-label' }, chip.desc),
          h('span', { class: 'chip-price' }, fmtAUD(chip.price)),
        )),
      ),
      h('div', { class: 'hint', style: 'margin-top:10px' }, 'Tap a chip to auto-fill, or type your own below.'),
    ),

    h('div', { class: 'card' },
      h('div', { class: 'row-2' },
        h('div', { class: 'field' },
          h('label', {}, 'What did you fix?'),
          h('input', {
            type: 'text',
            autocomplete: 'off',
            placeholder: 'e.g. Reset BIOS password',
            value: o.description || '',
            oninput: (e) => pushField('description', e.target.value),
          }),
        ),
        h('div', { class: 'field' },
          h('label', {}, 'Price (inc. GST)'),
          h('input', {
            type: 'number', min: '0', step: '0.01', inputmode: 'decimal',
            id: 'ots-price',
            placeholder: '0.00',
            value: o.price || '',
            oninput: (e) => {
              updateLiveTotal();
              pushField('price', Number(e.target.value) || 0);
            },
          }),
        ),
      ),
    ),

    h('div', { class: 'card' },
      h('div', { class: 'section-label' }, `Hourly charge — ${fmtAUD(rate)}/hr`),
      h('div', { class: 'row-2' },
        h('div', { class: 'field' },
          h('label', {}, 'Time spent with customer'),
          h('select', {
            onchange: (e) => pickHours(Number(e.target.value) || 0),
          },
            ...HOUR_OPTIONS.map(opt => {
              const el = document.createElement('option');
              el.value = String(opt.value);
              el.textContent = opt.label;
              if (Number(o.hours) === opt.value) el.selected = true;
              return el;
            }),
          ),
        ),
        h('div', { class: 'field' },
          h('label', {}, 'Hourly subtotal'),
          h('div', {
            class: 'line-total',
            id: 'ots-hours-total',
          }, fmtAUD((Number(o.hours) || 0) * rate)),
        ),
      ),
    ),

    h('div', { class: 'card' },
      h('div', { class: 'section-label' }, 'Notes (optional)'),
      h('div', { class: 'field' },
        h('label', {}, 'Internal notes about this job'),
        h('textarea', {
          placeholder: 'e.g. Customer mentioned slow boot — followed up with SSD recommendation.',
          style: 'min-height:60px',
          oninput: (e) => pushField('notes', e.target.value),
        }, o.notes || ''),
      ),
    ),

    h('div', { class: 'card' },
      h('div', { class: 'section-label' }, 'Payment'),
      h('div', { class: 'yn-toggle' },
        h('button', {
          type: 'button',
          class: `yn-btn ${o.paymentType === 'full' ? 'active' : ''}`,
          onclick: () => pickPayment('full'),
        }, 'Paying in full'),
        h('button', {
          type: 'button',
          class: `yn-btn ${o.paymentType === 'deposit' ? 'active' : ''}`,
          onclick: () => pickPayment('deposit'),
        }, 'Leaving a deposit'),
      ),
      o.paymentType === 'deposit' ? h('div', { class: 'field', style: 'margin-top:12px' },
        h('label', {}, 'Deposit amount'),
        h('input', {
          type: 'number', min: '0', step: '0.01', inputmode: 'decimal',
          placeholder: '0.00',
          value: o.depositAmount || '',
          oninput: (e) => pushField('depositAmount', Number(e.target.value) || 0),
        }),
      ) : null,
    ),

    h('div', { class: 'card' },
      h('div', { class: 'price-total' },
        h('span', { class: 'total-label' }, 'Total (inc. GST)'),
        h('span', { class: 'total-amount', id: 'ots-total' }, fmtAUD(computeOnTheSpotTotal(o))),
      ),
    ),

    signatureCard(job, 'drop_off'),

    resultBanner,

    h('div', { class: 'form-actions' },
      h('button', {
        class: 'btn btn-ghost',
        onclick: () => wsSend({ type: 'backToRouter' }),
      }, '← Back'),
      h('div', { class: 'spacer' }),
      h('button', {
        class: 'btn btn-primary',
        onclick: () => { lastOnTheSpotResult = null; wsSend({ type: 'submitOnTheSpot' }); },
      }, 'Next — Checkout →'),
    ),
  );
}
// ── Pickup flow ────────────────────────────────────────────────────────────
function fmtInvDate(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleDateString('en-AU', { day: 'numeric', month: 'short', year: 'numeric' });
  } catch { return iso; }
}

function computePickupTotals(pu) {
  const inv = pu?.selectedInvoiceId
    ? pu.invoices.find(i => i.invoiceId === pu.selectedInvoiceId)
    : null;
  const invoiceDue = Number(inv?.amountDue) || 0;
  const extrasTotal = (pu?.extraLines ?? []).reduce((s, l) => s + (Number(l.amount) || 0), 0);
  return { inv, invoiceDue, extrasTotal, total: invoiceDue + extrasTotal };
}

function viewPickup(job) {
  const pu = job.pickup;
  if (!pu) {
    return h('div', { class: 'card' }, h('p', {}, 'Loading pickup state…'));
  }

  const pushField = debounce((field, value) => wsSend({ type: 'pickupUpdateField', field, value }), 200);
  const pushLine = debounce((lineId, field, value) => wsSend({ type: 'pickupUpdateExtraLine', lineId, field, value }), 200);

  const updateLiveTotal = () => {
    const el = document.getElementById('pickup-total');
    const exEl = document.getElementById('pickup-extras-total');
    if (!el) return;
    const rows = [...document.querySelectorAll('[data-pickup-extra]')];
    const extras = rows.reduce((s, r) => s + (Number(r.querySelector('[data-pickup-amount]')?.value) || 0), 0);
    const { invoiceDue } = computePickupTotals(job.pickup);
    if (exEl) exEl.textContent = fmtAUD(extras);
    el.textContent = fmtAUD(invoiceDue + extras);
  };

  const backBtn = h('button', {
    class: 'btn btn-ghost',
    onclick: () => wsSend({ type: 'backToRouter' }),
  }, '← Back');

  // ── Loading / empty / error states ────────────────────────────────────────
  if (pu.loadState === 'loading') {
    return h('div', {},
      h('h1', {}, 'Pickup'),
      h('p', { class: 'sub' }, `Looking up open invoices for ${job.customer.firstName || 'this customer'}…`),
      h('div', { class: 'card placeholder-card' },
        h('div', { class: 'icon' }, '⏳'),
        h('p', { class: 'muted' }, 'One moment.'),
      ),
      h('div', { class: 'form-actions' }, backBtn),
    );
  }

  if (pu.loadState === 'error') {
    return h('div', {},
      h('h1', {}, 'Pickup'),
      h('div', { class: 'result-banner err' }, pu.loadError || 'Could not load invoices from Xero.'),
      h('div', { class: 'form-actions' },
        backBtn,
        h('div', { class: 'spacer' }),
        h('button', {
          class: 'btn btn-primary',
          onclick: () => wsSend({ type: 'pickupReload' }),
        }, 'Retry'),
      ),
    );
  }

  if (pu.loadState === 'empty') {
    return h('div', {},
      h('h1', {}, 'No open invoices'),
      h('p', { class: 'sub' },
        `${job.customer.firstName || 'This customer'} has no open Xero invoices. If you just created one, tap Retry.`),
      h('div', { class: 'form-actions' },
        backBtn,
        h('div', { class: 'spacer' }),
        h('button', {
          class: 'btn btn-ghost',
          onclick: () => wsSend({ type: 'pickupSeedTestInvoice' }),
          title: 'Dev helper — remove when real invoices exist',
        }, '+ Sample invoice (dev)'),
        h('button', {
          class: 'btn btn-ghost',
          onclick: () => wsSend({ type: 'pickupReload' }),
        }, 'Retry'),
      ),
    );
  }

  // ── No invoice picked yet: show the list ──────────────────────────────────
  if (!pu.selectedInvoiceId) {
    return h('div', {},
      h('h1', {}, 'Which invoice?'),
      h('p', { class: 'sub' },
        `${job.customer.firstName || 'This customer'} has ${pu.invoices.length} open ${pu.invoices.length === 1 ? 'invoice' : 'invoices'}. Pick the one they're collecting.`),

      h('div', { class: 'card' },
        h('div', { class: 'invoice-list' },
          ...pu.invoices.map(inv => h('button', {
            type: 'button',
            class: 'invoice-row',
            onclick: () => wsSend({ type: 'pickupSelectInvoice', invoiceId: inv.invoiceId }),
          },
            h('div', { class: 'inv-head' },
              h('span', { class: 'inv-num' }, inv.invoiceNumber),
              h('span', { class: 'inv-date' }, fmtInvDate(inv.createdAt)),
            ),
            h('div', { class: 'inv-body' },
              h('span', { class: 'inv-summary' },
                inv.lineItems.length === 1
                  ? inv.lineItems[0].description
                  : `${inv.lineItems.length} items${inv.reference ? ` — ${inv.reference}` : ''}`,
              ),
              h('span', { class: 'inv-amount' },
                h('span', { class: 'inv-due' }, fmtAUD(inv.amountDue)),
                Number(inv.amountPaid) > 0
                  ? h('span', { class: 'inv-paid' }, `${fmtAUD(inv.amountPaid)} paid`)
                  : null,
              ),
            ),
          )),
        ),
      ),

      h('div', { class: 'form-actions' },
        backBtn,
        h('div', { class: 'spacer' }),
        h('button', {
          class: 'btn btn-ghost',
          onclick: () => wsSend({ type: 'pickupSeedTestInvoice' }),
          title: 'Dev helper — remove when real invoices exist',
        }, '+ Sample invoice (dev)'),
        h('button', {
          class: 'btn btn-ghost',
          onclick: () => wsSend({ type: 'pickupReload' }),
        }, 'Refresh list'),
      ),
    );
  }

  // ── Invoice picked: summary + optional extras ─────────────────────────────
  const { inv, invoiceDue, extrasTotal, total } = computePickupTotals(pu);
  if (!inv) {
    // Fallback if selection is somehow stale
    return h('div', { class: 'card' },
      h('p', {}, 'Selected invoice no longer in the list.'),
      h('button', { class: 'btn btn-primary', onclick: () => wsSend({ type: 'pickupClearSelection' }) }, 'Pick another'),
    );
  }

  const extraRow = (line, idx) => h('div', { class: 'svc-entry', 'data-pickup-extra': '1' },
    h('div', { class: 'svc-num' }, String(idx + 1)),
    h('button', {
      class: 'svc-remove',
      type: 'button',
      title: 'Remove',
      onclick: () => wsSend({ type: 'pickupRemoveExtraLine', lineId: line.id }),
    }, '×'),
    h('div', { class: 'svc-body' },
      h('div', { class: 'field' },
        h('label', {}, 'What was the extra charge for?'),
        h('input', {
          type: 'text',
          autocomplete: 'off',
          placeholder: 'e.g. Additional 2 hours diagnostic',
          value: line.description || '',
          oninput: (e) => pushLine(line.id, 'description', e.target.value),
        }),
      ),
      h('div', { class: 'field' },
        h('label', {}, 'Amount (inc. GST)'),
        h('input', {
          type: 'number', min: '0', step: '0.01', inputmode: 'decimal',
          'data-pickup-amount': '1',
          placeholder: '0.00',
          value: line.amount || '',
          oninput: (e) => { updateLiveTotal(); pushLine(line.id, 'amount', Number(e.target.value) || 0); },
        }),
      ),
    ),
  );

  const resultBanner = lastPickupResult && !lastPickupResult.ok
    ? h('div', { class: 'result-banner err' },
        lastPickupResult.detail || `Error: ${lastPickupResult.error}`)
    : null;

  const customerLabel = [job.customer.firstName, job.customer.lastName].filter(Boolean).join(' ') || inv.contactId;

  return h('div', {},
    h('h1', {}, `Picking up ${inv.invoiceNumber}`),
    h('p', { class: 'sub' }, `Raised ${fmtInvDate(inv.createdAt)} for ${job.customer.firstName || 'this customer'}.`),

    inv.contactId ? h('div', { style: 'margin-bottom:12px' },
      h('button', {
        class: 'btn btn-ghost btn-sm-top',
        style: 'margin-left:0',
        onclick: () => revealPasswordForContact(inv.contactId, customerLabel),
      }, '🔒 Reveal computer password'),
    ) : null,

    h('div', { class: 'card' },
      h('div', { class: 'section-label' }, 'Invoice items'),
      h('div', { class: 'rows pickup-rows' },
        ...inv.lineItems.map(li => h('div', { class: 'row' },
          h('div', { class: 'label' }, li.description + (li.quantity > 1 ? ` × ${li.quantity}` : '')),
          h('div', { class: 'value' }, fmtAUD(li.quantity * li.unitPriceIncGst)),
        )),
      ),
      h('div', { class: 'invoice-meta' },
        h('div', { class: 'row' },
          h('div', { class: 'label' }, 'Invoice total'),
          h('div', { class: 'value' }, fmtAUD(inv.totalIncGst)),
        ),
        Number(inv.amountPaid) > 0 ? h('div', { class: 'row' },
          h('div', { class: 'label' }, 'Deposit paid'),
          h('div', { class: 'value muted' }, `− ${fmtAUD(inv.amountPaid)}`),
        ) : null,
        h('div', { class: 'row strong' },
          h('div', { class: 'label' }, 'Balance on this invoice'),
          h('div', { class: 'value' }, fmtAUD(invoiceDue)),
        ),
      ),
      h('div', { style: 'margin-top:12px' },
        h('button', {
          class: 'btn btn-ghost btn-sm-top',
          style: 'margin-left:0',
          onclick: () => wsSend({ type: 'pickupClearSelection' }),
        }, 'Pick a different invoice'),
      ),
    ),

    h('div', { class: 'card' },
      h('div', { class: 'section-label' }, 'Extra charges today (optional)'),
      h('p', { class: 'hint', style: 'margin-bottom:12px' },
        'Only add if the final cost went over the original invoice. These become a second invoice at checkout.'),
      pu.extraLines.length
        ? h('div', { class: 'stack' }, ...pu.extraLines.map((l, i) => extraRow(l, i)))
        : null,
      h('button', {
        class: 'add-svc-btn',
        type: 'button',
        onclick: () => wsSend({ type: 'pickupAddExtraLine' }),
      },
        h('span', { style: 'font-size:20px;line-height:1' }, '+'),
        pu.extraLines.length ? ' Add another extra charge' : ' Add an extra charge',
      ),
      pu.extraLines.length ? h('div', { class: 'row strong', style: 'margin-top:12px' },
        h('div', { class: 'label' }, 'Extras subtotal'),
        h('div', { class: 'value', id: 'pickup-extras-total' }, fmtAUD(extrasTotal)),
      ) : null,
    ),

    h('div', { class: 'card' },
      h('div', { class: 'section-label' }, 'Notes (optional)'),
      h('div', { class: 'field' },
        h('label', {}, 'Anything to remember about this pickup?'),
        h('textarea', {
          placeholder: 'e.g. Mentioned they\'d like to book a follow-up next month.',
          style: 'min-height:60px',
          oninput: (e) => pushField('extraNotes', e.target.value),
        }, pu.extraNotes || ''),
      ),
    ),

    h('div', { class: 'card' },
      h('div', { class: 'price-total' },
        h('span', { class: 'total-label' }, 'Due today'),
        h('span', { class: 'total-amount', id: 'pickup-total' }, fmtAUD(total)),
      ),
    ),

    signatureCard(job, 'pick_up'),

    resultBanner,

    h('div', { class: 'form-actions' },
      backBtn,
      h('div', { class: 'spacer' }),
      h('button', {
        class: 'btn btn-primary',
        onclick: () => { lastPickupResult = null; wsSend({ type: 'submitPickup' }); },
      }, 'Next — Checkout →'),
    ),
  );
}

// ── Main render ────────────────────────────────────────────────────────────
function render() {
  if (!job) {
    $badge.style.display = 'none';
    $app.replaceChildren(viewDashboard());
    return;
  }

  $badge.style.display = '';
  $badge.textContent = `Job ${job.id}`;

  switch (job.step) {
    case 'intake':      $app.replaceChildren(viewIntake(job)); break;
    case 'route':       $app.replaceChildren(viewRouter(job)); break;
    case 'repair':      $app.replaceChildren(viewRepair(job)); break;
    case 'product':     $app.replaceChildren(viewProduct(job)); break;
    case 'on_the_spot': $app.replaceChildren(viewOnTheSpot(job)); break;
    case 'pickup':      $app.replaceChildren(viewPickup(job)); break;
    case 'checkout':    $app.replaceChildren(viewCheckout(job)); break;
    default:            $app.replaceChildren(viewDashboard());
  }
}

// ── Boot ───────────────────────────────────────────────────────────────────
fetch('/api/me').then(r => r.json()).then(({ user }) => {
  $meName.textContent = user?.name ?? '';
});
connectWs();
render();
