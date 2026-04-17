// Settings page logic. Pulls current settings, renders the UI, wires up
// toggles + test buttons, and polls /api/audit every 2s.

const INTEGRATIONS = [
  { key: 'xero',  label: 'Xero' },
  { key: 'tyro',  label: 'Tyro EFTPOS' },
  { key: 'email', label: 'Email (SMTP)' },
];

const FLAG_CONFIG = [
  {
    path: ['flags', 'customerPasswordField', 'show'],
    label: 'Show "computer password" field on customer intake',
    note: 'Optional field for staff — encrypted at rest, auto-purged 30 days after pickup.',
  },
  {
    path: ['flags', 'reviewEmail', 'sendOnPickup'],
    label: 'Send Google review email after pickup',
    note: 'Sent 30 minutes after the job card moves to Done / Collected.',
  },
];

async function api(method, url, body) {
  const opts = { method, headers: { 'Content-Type': 'application/json' } };
  if (body !== undefined) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`${method} ${url} → ${res.status}`);
  return res.status === 204 ? null : res.json();
}

function get(obj, path) {
  return path.reduce((o, k) => (o ?? {})[k], obj);
}

function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k === 'onclick') el.onclick = v;
    else if (k === 'onchange') el.onchange = v;
    else el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null) continue;
    el.append(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return el;
}

// ── Connections ─────────────────────────────────────────────────────────────
function renderConnections(settings) {
  const root = document.getElementById('connections');
  root.innerHTML = '';
  for (const { key, label } of INTEGRATIONS) {
    const intg = settings.integrations[key];
    const statusBadge = intg.useLive
      ? h('span', { class: 'status live' }, 'Live')
      : h('span', { class: 'status stub' }, 'Stub mode');

    const testBtn = h('button', { class: 'btn btn-ghost btn-sm', onclick: () => testIntegration(key) }, 'Test');
    const resultEl = h('div', { id: `test-${key}`, class: 'test-result' });

    const row = h('div', { class: 'row' },
      h('div', { class: 'meta' },
        h('div', { class: 'name' }, label, ' ', statusBadge),
        intg.note ? h('div', { class: 'note' }, intg.note) : null,
        resultEl,
      ),
      h('div', {}, testBtn),
    );
    root.appendChild(row);
  }
}

async function testIntegration(key) {
  const resultEl = document.getElementById(`test-${key}`);
  resultEl.className = 'test-result show';
  resultEl.textContent = 'Testing…';
  try {
    const res = await api('POST', `/api/integrations/${key}/test`);
    resultEl.className = `test-result show ${res.ok ? 'ok' : 'error'}`;
    resultEl.textContent = `${res.ok ? 'OK' : 'FAIL'} · ${res.mode} · ${res.message}`;
    refreshAudit();
  } catch (err) {
    resultEl.className = 'test-result show error';
    resultEl.textContent = err.message;
  }
}

// ── Flags ───────────────────────────────────────────────────────────────────
function renderFlags(settings) {
  const root = document.getElementById('flags');
  root.innerHTML = '';
  for (const cfg of FLAG_CONFIG) {
    const current = get(settings, cfg.path);
    const input = h('input', { type: 'checkbox' });
    input.checked = !!current;
    input.onchange = () => updateFlag(cfg.path, input.checked);
    const row = h('div', { class: 'row' },
      h('div', { class: 'meta' },
        h('div', { class: 'name' }, cfg.label),
        cfg.note ? h('div', { class: 'note' }, cfg.note) : null,
      ),
      h('label', { class: 'toggle' }, input, h('span', { class: 'slider' })),
    );
    root.appendChild(row);
  }
}

async function updateFlag(path, value) {
  // path looks like ['flags', 'customerPasswordField', 'show']
  // Build a nested patch object: { flags: { customerPasswordField: { show: value } } }
  const patch = {};
  let cursor = patch;
  for (let i = 0; i < path.length - 1; i++) {
    cursor[path[i]] = {};
    cursor = cursor[path[i]];
  }
  cursor[path[path.length - 1]] = value;
  await api('PUT', '/api/settings', patch);
}

// ── Audit log ───────────────────────────────────────────────────────────────
function renderAudit(entries) {
  const root = document.getElementById('audit');
  root.innerHTML = '';
  if (entries.length === 0) {
    root.appendChild(h('div', { class: 'audit-empty' }, 'No activity yet. Click Test on any integration above.'));
    return;
  }
  const table = h('table', { class: 'audit-table' });
  const thead = h('thead', {}, h('tr', {},
    h('th', {}, 'Time'),
    h('th', {}, 'Service'),
    h('th', {}, 'Method'),
    h('th', {}, 'Mode'),
    h('th', {}, 'Status'),
    h('th', {}, 'Duration'),
    h('th', {}, 'Summary'),
  ));
  const tbody = h('tbody', {});
  for (const e of entries) {
    const t = new Date(e.timestamp);
    const hhmmss = t.toTimeString().slice(0, 8);
    tbody.appendChild(h('tr', {},
      h('td', { class: 'mono' }, hhmmss),
      h('td', {}, e.service),
      h('td', { class: 'mono' }, e.method),
      h('td', {}, e.mode),
      h('td', { class: e.status }, e.status),
      h('td', { class: 'mono' }, `${e.durationMs}ms`),
      h('td', {}, e.summary ?? ''),
    ));
  }
  table.append(thead, tbody);
  root.appendChild(table);
}

async function refreshAudit() {
  try {
    const { entries } = await api('GET', '/api/audit');
    renderAudit(entries);
  } catch (err) {
    console.error('audit refresh failed', err);
  }
}

async function clearAudit() {
  await api('DELETE', '/api/audit');
  refreshAudit();
}

async function resetStubs() {
  const el = document.getElementById('reset-result');
  el.className = 'test-result show';
  el.textContent = 'Resetting…';
  try {
    const r = await api('POST', '/api/dev/reset-stubs');
    el.className = 'test-result show ok';
    el.textContent = r.message || 'Done';
    refreshAudit();
  } catch (err) {
    el.className = 'test-result show error';
    el.textContent = err.message;
  }
}

// ── Boot ────────────────────────────────────────────────────────────────────
async function boot() {
  // Wire up the audit + dev-tool buttons programmatically. Inline onclick=""
  // handlers relied on globals which were unreliable under module/script timing.
  document.getElementById('audit-refresh-btn')?.addEventListener('click', refreshAudit);
  document.getElementById('audit-clear-btn')?.addEventListener('click', clearAudit);
  document.getElementById('reset-stubs-btn')?.addEventListener('click', resetStubs);

  const [meRes, settings] = await Promise.all([
    fetch('/api/me').then(r => r.json()),
    api('GET', '/api/settings'),
  ]);
  document.getElementById('me-name').textContent = meRes.user?.name ?? '';
  renderConnections(settings);
  renderFlags(settings);
  refreshAudit();
  setInterval(refreshAudit, 2000);
}

boot().catch(err => {
  document.body.innerHTML = `<div class="container"><h1>Failed to load</h1><pre>${err.message}</pre></div>`;
});
