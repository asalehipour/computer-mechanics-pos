// Job Board — kanban view of every checked-out job. Cards move between
// columns via drag-and-drop; each card opens a modal with details and a
// comment thread. State syncs across tabs through the existing WebSocket
// (boardState messages).

const $board = document.getElementById('board-root');
const $drawer = document.getElementById('drawer-root');
const $meName = document.getElementById('me-name');
const $search = document.getElementById('board-search');
const $searchCount = document.getElementById('board-search-count');

let entries = [];
let me = null;
let ws = null;
let wsReady = false;
let openEntryId = null;
let dragEntryId = null;
let searchQuery = '';
// Drawer-local edit state. Persists across re-renders so a staff member can
// keep typing when the board state refreshes under them.
let editDetailsMode = false;
let editingCommentId = null;
let editDraft = {}; // field -> value, only populated while editDetailsMode is true

// Must match src/job-board.ts BOARD_STATUSES exactly.
const COLUMNS = [
  { status: 'booked_in',            title: 'Booked in',             accent: '#4a90e2' },
  { status: 'in_progress',          title: 'In Progress',           accent: '#7b68ee' },
  { status: 'waiting_parts',        title: 'Waiting on Parts',      accent: '#e2a64a' },
  { status: 'waiting_customer',     title: 'Waiting on Customer',   accent: '#e26d4a' },
  { status: 'waiting_third_party',  title: 'Waiting on Third Party',accent: '#c94a4a' },
  { status: 'ready_for_collection', title: 'Ready for Collection',  accent: '#2ea44f' },
  { status: 'done_collected',       title: 'Done / Collected',      accent: '#6a737d' },
  { status: 'on_the_spot',          title: 'On the spot',           accent: '#17a2b8' },
];

// ── DOM helpers ───────────────────────────────────────────────────────────
function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'checked' || k === 'disabled' || k === 'draggable') { if (v) el.setAttribute(k, typeof v === 'string' ? v : ''); }
    else if (v !== undefined && v !== null) el.setAttribute(k, v);
  }
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(typeof c === 'string' || typeof c === 'number' ? document.createTextNode(String(c)) : c);
  }
  return el;
}

function fmtAUD(n) { return `$${(Number(n) || 0).toFixed(2)}`; }

function fmtRelative(iso) {
  if (!iso) return '';
  const then = new Date(iso).getTime();
  if (!Number.isFinite(then)) return '';
  const sec = Math.round((Date.now() - then) / 1000);
  if (sec < 60) return 'just now';
  if (sec < 3600) return `${Math.floor(sec / 60)} min ago`;
  if (sec < 86400) return `${Math.floor(sec / 3600)} hr ago`;
  if (sec < 86400 * 7) return `${Math.floor(sec / 86400)} days ago`;
  try {
    return new Date(iso).toLocaleDateString('en-AU', { day: 'numeric', month: 'short' });
  } catch { return ''; }
}

function fmtAbs(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleString('en-AU', { dateStyle: 'medium', timeStyle: 'short' });
  } catch { return ''; }
}

function flowLabel(flow) {
  switch (flow) {
    case 'repair':      return 'Repair';
    case 'product':     return 'Product';
    case 'on_the_spot': return 'Quick fix';
    case 'pickup':      return 'Pickup';
    default:            return flow;
  }
}

function methodLabel(m) {
  if (m === 'cash') return 'Cash';
  if (m === 'card') return 'Card';
  if (m === 'pay_later') return 'Pay later';
  return '—';
}

function intentLabel(v) {
  // Data keys are preserved ('leaving' = device stays at shop, 'taking' =
  // customer has it with them) so existing job-board entries still render;
  // the labels are the friendlier "Where is the device?" wording.
  if (v === 'leaving') return 'In store';
  if (v === 'taking') return 'With the customer';
  if (v === 'na') return 'N/A';
  return '—';
}

const INTENT_OPTIONS = [
  { key: 'leaving', label: 'In store' },
  { key: 'taking',  label: 'With the customer' },
  { key: 'na',      label: 'N/A' },
];

// ── WebSocket ─────────────────────────────────────────────────────────────
function connectWs() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(`${proto}://${location.host}/ws`);
  ws.addEventListener('open', () => {
    wsReady = true;
    updateConnIndicator();
    ws.send(JSON.stringify({ type: 'subscribe', audience: 'staff' }));
    // Ask for a fresh snapshot in case our subscribe arrived before any state push.
    ws.send(JSON.stringify({ type: 'boardRefresh' }));
  });
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.type === 'boardState' && Array.isArray(msg.entries)) {
      entries = msg.entries;
      render();
      if (openEntryId) {
        const match = entries.find(e => e.id === openEntryId);
        if (match) renderDrawer(match);
        else closeDrawer();
      }
    }
  });
  ws.addEventListener('close', () => {
    wsReady = false;
    updateConnIndicator();
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
  }
}

function updateConnIndicator() {
  const el = document.getElementById('conn-indicator');
  if (!el) return;
  el.classList.toggle('offline', !wsReady);
  el.title = wsReady ? 'Connected' : 'Reconnecting…';
}

// ── Rendering ─────────────────────────────────────────────────────────────
function sortEntries(list) {
  return list.slice().sort((a, b) => (b.sortKey || 0) - (a.sortKey || 0));
}

// Strip everything but digits — used so "0407 194 821" matches "0407194821"
// and "+61488…" matches "61488…" and vice versa.
function normalizePhone(s) {
  return String(s || '').replace(/\D+/g, '');
}

function matchesSearch(entry, q) {
  if (!q) return true;
  const query = q.trim().toLowerCase();
  if (!query) return true;
  // Exact/partial job id OR human display number (e.g. "#1051" / "1051")
  const jobNeedle = query.replace(/^#/, '');
  if (entry.jobId && String(entry.jobId).toLowerCase().includes(jobNeedle)) return true;
  if (entry.displayNumber != null && String(entry.displayNumber).includes(jobNeedle)) return true;
  // Customer name / email / device model
  if ((entry.customerName || '').toLowerCase().includes(query)) return true;
  if ((entry.customerEmail || '').toLowerCase().includes(query)) return true;
  if ((entry.deviceModel || '').toLowerCase().includes(query)) return true;
  // Phone — strip non-digits and substring-match
  const phoneDigits = normalizePhone(entry.customerPhone);
  const queryDigits = normalizePhone(query);
  if (queryDigits && phoneDigits.includes(queryDigits)) return true;
  return false;
}

function updateSearchCount(total, shown) {
  if (!$searchCount) return;
  if (!searchQuery.trim()) { $searchCount.textContent = ''; return; }
  $searchCount.textContent = `${shown} of ${total}`;
}

function render() {
  const filtered = entries.filter(e => matchesSearch(e, searchQuery));
  const byStatus = new Map(COLUMNS.map(c => [c.status, []]));
  for (const e of filtered) {
    if (byStatus.has(e.status)) byStatus.get(e.status).push(e);
  }
  const cols = COLUMNS.map(col => renderColumn(col, sortEntries(byStatus.get(col.status) || [])));
  $board.replaceChildren(...cols);
  updateSearchCount(entries.length, filtered.length);
}

function renderColumn(col, colEntries) {
  const dropHandler = (ev) => {
    ev.preventDefault();
    ev.currentTarget.classList.remove('drop-over');
    if (dragEntryId) {
      wsSend({ type: 'boardMove', entryId: dragEntryId, status: col.status });
      dragEntryId = null;
    }
  };
  return h('div', {
    class: 'board-col',
    style: `--col-accent:${col.accent}`,
    ondragover: (ev) => { ev.preventDefault(); ev.currentTarget.classList.add('drop-over'); },
    ondragleave: (ev) => { ev.currentTarget.classList.remove('drop-over'); },
    ondrop: dropHandler,
  },
    h('div', { class: 'board-col-head' },
      h('span', { class: 'board-col-title' }, col.title),
      h('span', { class: 'board-col-count' }, String(colEntries.length)),
    ),
    h('div', { class: 'board-col-body' },
      colEntries.length === 0
        ? h('div', { class: 'board-col-empty' }, 'No cards')
        : colEntries.map(renderCard),
    ),
  );
}

function renderCard(entry) {
  return h('div', {
    class: 'board-card',
    draggable: 'true',
    'data-entry-id': entry.id,
    ondragstart: (ev) => {
      dragEntryId = entry.id;
      ev.currentTarget.classList.add('dragging');
      try { ev.dataTransfer.setData('text/plain', entry.id); } catch {}
      if (ev.dataTransfer) ev.dataTransfer.effectAllowed = 'move';
    },
    ondragend: (ev) => {
      ev.currentTarget.classList.remove('dragging');
      dragEntryId = null;
    },
    onclick: () => openDrawer(entry.id),
  },
    h('div', { class: 'board-card-top' },
      h('span', { class: 'board-card-emoji' }, entry.deviceEmoji || '💻'),
      h('span', { class: 'board-card-id' }, `#${entry.displayNumber ?? entry.jobId}`),
      entry.parts?.length
        ? h('span', { class: 'board-card-parts', title: `${entry.parts.length} part(s) on order` },
            '📦 ', String(entry.parts.length))
        : null,
      entry.comments?.length
        ? h('span', { class: 'board-card-comments', title: `${entry.comments.length} comment(s)` },
            '💬 ', String(entry.comments.length))
        : null,
    ),
    h('div', { class: 'board-card-name' }, entry.customerName || '—'),
    h('div', { class: 'board-card-device' }, entry.deviceModel || 'No device info'),
    h('div', { class: 'board-card-foot' },
      h('span', { class: 'board-card-flow' }, flowLabel(entry.flow)),
      h('span', { class: 'board-card-time' }, fmtRelative(entry.updatedAt)),
    ),
  );
}

// ── Drawer ────────────────────────────────────────────────────────────────
// Cache of revealed plaintexts, keyed by passwordRecordId. Populated when
// the drawer auto-reveals on open; cleared by the "Hide" button. Scoped to
// this tab only — a hard refresh wipes it, forcing a fresh audit entry.
const revealedPasswords = new Map();
// Guards against firing two concurrent reveal requests for the same record
// while the user rapid-opens/closes the drawer.
const pendingReveals = new Set();

function openDrawer(entryId) {
  openEntryId = entryId;
  editDetailsMode = false;
  editingCommentId = null;
  editDraft = {};
  const entry = entries.find(e => e.id === entryId);
  if (!entry) return;
  renderDrawer(entry);
  // Fire-and-forget: fetch the plaintext as the drawer opens so staff don't
  // need to click Reveal. One audit log entry per open with a fixed reason.
  if (entry.passwordRecordId) autoRevealPassword(entry);
}

async function autoRevealPassword(entry) {
  const recordId = entry.passwordRecordId;
  if (!recordId) return;
  if (revealedPasswords.has(recordId)) return; // already cached this session
  if (pendingReveals.has(recordId)) return;
  pendingReveals.add(recordId);
  try {
    const r = await fetch(`/api/password/reveal/${encodeURIComponent(recordId)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: 'Viewed on job card' }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.ok) return; // silent — UI will keep showing the fallback
    revealedPasswords.set(recordId, body.plaintext);
    // If the drawer is still showing this entry, re-render to swap the
    // placeholder for the plaintext.
    if (openEntryId === entry.id) renderDrawer(entry);
  } catch {
    /* swallow — transient network, user can click Retry in the card */
  } finally {
    pendingReveals.delete(recordId);
  }
}

function closeDrawer() {
  openEntryId = null;
  editDetailsMode = false;
  editingCommentId = null;
  editDraft = {};
  $drawer.replaceChildren();
}

// Derive a friendly label from a URL — the hostname without "www.".
function domainFromUrl(url) {
  try {
    const u = new URL(url);
    return u.hostname.replace(/^www\./i, '');
  } catch { return ''; }
}

// Ensure a URL is safe to put in a link (reject data:, javascript:, etc.).
function safeHref(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:') return u.toString();
  } catch {}
  return '';
}

async function revealBoardPassword(recordId, btn) {
  const reason = prompt('Why are you accessing this password?\n\nThis is logged.');
  if (!reason || !reason.trim()) return;
  btn.setAttribute('disabled', '');
  const original = btn.textContent;
  btn.textContent = 'Revealing…';
  try {
    const r = await fetch(`/api/password/reveal/${encodeURIComponent(recordId)}`, {
      method: 'POST',
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ reason: reason.trim() }),
    });
    const body = await r.json().catch(() => ({}));
    if (!r.ok || !body.ok) throw new Error(body.error || `reveal_failed (${r.status})`);
    // Replace the button with a read-only plaintext field and a copy button.
    const display = document.getElementById(`pwd-display-${recordId}`);
    if (display) {
      display.replaceChildren(
        h('code', { class: 'drawer-pwd-plain' }, body.plaintext),
        h('button', {
          class: 'btn btn-ghost btn-sm-top',
          type: 'button',
          onclick: () => {
            navigator.clipboard?.writeText(body.plaintext).then(
              () => { /* no-op */ },
              () => alert('Could not copy to clipboard.'),
            );
          },
        }, 'Copy'),
      );
    }
  } catch (err) {
    btn.removeAttribute('disabled');
    btn.textContent = original;
    const msg = err instanceof Error ? err.message : String(err);
    alert(msg === 'expired'
      ? 'This password record has been purged (30-day retention).'
      : msg === 'not_found'
      ? 'Password record not found — it may have been purged.'
      : `Could not reveal password: ${msg}`);
  }
}

function renderDrawer(entry) {
  const statusSelect = h('select', {
    class: 'drawer-status-select',
    onchange: (ev) => wsSend({ type: 'boardMove', entryId: entry.id, status: ev.target.value }),
  },
    ...COLUMNS.map(c => h('option', {
      value: c.status,
      selected: c.status === entry.status ? '' : undefined,
    }, c.title)),
  );

  const commentInput = h('textarea', {
    class: 'drawer-comment-input',
    placeholder: 'Leave a comment…',
    rows: '3',
  });
  const submitComment = () => {
    const body = commentInput.value.trim();
    if (!body) return;
    wsSend({ type: 'boardAddComment', entryId: entry.id, body });
    commentInput.value = '';
  };
  commentInput.addEventListener('keydown', (ev) => {
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') { ev.preventDefault(); submitComment(); }
  });

  // Device intent picker — three-way segmented control. Reflects entry state
  // unless there's an unsaved edit draft.
  const currentIntent = editDetailsMode && 'deviceIntent' in editDraft
    ? editDraft.deviceIntent
    : (entry.deviceIntent ?? null);
  const intentPicker = h('div', { class: 'drawer-intent-picker' },
    ...INTENT_OPTIONS.map(opt => h('button', {
      type: 'button',
      class: currentIntent === opt.key ? 'drawer-intent-btn selected' : 'drawer-intent-btn',
      onclick: () => {
        // Always send immediately so device intent changes don't need the
        // "Edit details" flow — this is the common adjustment ("customer
        // changed their mind, they're leaving the device").
        wsSend({ type: 'boardUpdateEntry', entryId: entry.id, field: 'deviceIntent', value: opt.key });
      },
    }, opt.label)),
  );

  const meta = editDetailsMode
    ? buildEditableMeta(entry)
    : h('div', { class: 'drawer-meta' },
        metaRow('Customer', entry.customerName || '—'),
        metaRow('Email', entry.customerEmail || '—'),
        metaRow('Phone', entry.customerPhone || '—'),
        metaRow('Flow', flowLabel(entry.flow)),
        metaRow('Device', entry.deviceModel || '—'),
        h('div', { class: 'drawer-meta-row' },
          h('span', { class: 'drawer-meta-label' }, 'Where is the device?'),
          h('span', { class: 'drawer-meta-value' }, intentLabel(entry.deviceIntent)),
        ),
        metaRow('Invoices', (entry.invoiceNumbers || []).join(', ') || '—'),
        metaRow('Amount due', fmtAUD(entry.amountDueToday)),
        metaRow('Paid', `${fmtAUD(entry.amountPaid)} · ${methodLabel(entry.paymentMethod)}`),
        metaRow('Booked by', entry.createdBy?.name || '—'),
        metaRow('Created', fmtAbs(entry.createdAt)),
        metaRow('Last updated', fmtAbs(entry.updatedAt)),
      );

  const detailsToggleBtn = editDetailsMode
    ? h('div', { class: 'drawer-edit-actions' },
        h('button', {
          class: 'btn btn-ghost btn-sm-top',
          type: 'button',
          onclick: () => { editDetailsMode = false; editDraft = {}; renderDrawer(entry); },
        }, 'Cancel'),
        h('button', {
          class: 'btn btn-primary btn-sm-top',
          type: 'button',
          onclick: () => saveDetailEdits(entry),
        }, 'Save changes'),
      )
    : h('button', {
        class: 'btn btn-ghost btn-sm-top drawer-edit-toggle',
        type: 'button',
        onclick: () => {
          editDetailsMode = true;
          editDraft = {
            customerName: entry.customerName || '',
            customerEmail: entry.customerEmail || '',
            customerPhone: entry.customerPhone || '',
            deviceModel: entry.deviceModel || '',
          };
          renderDrawer(entry);
        },
      }, 'Edit details');

  // Newest first — ordered by createdAt desc so the most recent activity is
  // at the top of the drawer. Falls back to array order if timestamps tie.
  const sortedComments = (entry.comments || []).slice().sort((a, b) => {
    const ta = Date.parse(a.createdAt) || 0;
    const tb = Date.parse(b.createdAt) || 0;
    return tb - ta;
  });
  const commentList = sortedComments.length === 0
    ? h('p', { class: 'drawer-comments-empty' }, 'No comments yet.')
    : h('div', { class: 'drawer-comments' },
        ...sortedComments.map(c => renderComment(entry, c)),
      );

  const descSection = entry.jobDescription
    ? h('div', { class: 'drawer-section' },
        h('h4', {}, 'Job description'),
        h('p', { class: 'drawer-jobdesc' }, entry.jobDescription),
      )
    : null;

  // Password — only shown when a passwordRecordId exists. The record itself
  // auto-expires after 30 days; the server surfaces that via the "expired"
  // error which we translate into a friendly message.
  //
  // As of v3.2.0 the drawer auto-reveals on open — no more clicking "Reveal".
  // One audit entry per open. Staff can click "Hide" to blank the card
  // temporarily (e.g. customer peering at the screen) and re-tapping the
  // entry will pull it back.
  const passwordSection = entry.passwordRecordId
    ? (() => {
        const recordId = entry.passwordRecordId;
        const plain = revealedPasswords.get(recordId);
        const pwdRow = plain != null
          ? h('div', { class: 'drawer-pwd-row', id: `pwd-display-${recordId}` },
              h('code', { class: 'drawer-pwd-plain' }, plain),
              h('button', {
                class: 'btn btn-ghost btn-sm-top',
                type: 'button',
                onclick: () => {
                  navigator.clipboard?.writeText(plain).then(
                    () => { /* no-op */ },
                    () => alert('Could not copy to clipboard.'),
                  );
                },
              }, 'Copy'),
              h('button', {
                class: 'btn btn-ghost btn-sm-top',
                type: 'button',
                onclick: () => {
                  revealedPasswords.delete(recordId);
                  renderDrawer(entry);
                },
              }, 'Hide'),
            )
          : h('div', { class: 'drawer-pwd-row', id: `pwd-display-${recordId}` },
              h('span', { class: 'pwd-saved-badge' }, '✓ Encrypted — loading…'),
              h('button', {
                class: 'btn btn-ghost btn-sm-top',
                type: 'button',
                // Manual re-attempt if the auto-reveal above failed (network,
                // expired record, etc.). Falls back to the old prompt flow.
                onclick: (ev) => revealBoardPassword(recordId, ev.currentTarget),
              }, 'Retry'),
            );
        return h('div', { class: 'drawer-section' },
          h('h4', {}, 'Computer password'),
          pwdRow,
          h('div', { class: 'drawer-pwd-hint' }, 'Auto-purged 30 days after intake. Each view is logged.'),
        );
      })()
    : null;

  // Parts ordered — list above comments, newest first. Plus an inline form
  // to add a new part (name + URL). Domain is inferred client-side for the
  // live preview and confirmed by the server when the part is saved.
  const partNameInput = h('input', {
    type: 'text', placeholder: 'What you ordered (e.g. Screen for Envy x360 15-EY)',
    class: 'drawer-part-name-input',
  });
  const partUrlInput = h('input', {
    type: 'url', placeholder: 'https://ebay.com.au/...',
    class: 'drawer-part-url-input',
  });
  const submitPart = () => {
    const name = partNameInput.value.trim();
    const url = partUrlInput.value.trim();
    if (!name || !url) return;
    if (!safeHref(url)) {
      alert('Please paste a valid http(s) URL.');
      return;
    }
    wsSend({ type: 'boardAddPart', entryId: entry.id, name, url });
    partNameInput.value = '';
    partUrlInput.value = '';
  };
  const onPartKeyDown = (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); submitPart(); }
  };
  partNameInput.addEventListener('keydown', onPartKeyDown);
  partUrlInput.addEventListener('keydown', onPartKeyDown);

  const sortedParts = (entry.parts || []).slice().sort((a, b) => {
    const ta = Date.parse(a.createdAt) || 0;
    const tb = Date.parse(b.createdAt) || 0;
    return tb - ta;
  });
  const partsList = sortedParts.length === 0
    ? h('p', { class: 'drawer-parts-empty' }, 'Nothing on order yet.')
    : h('ul', { class: 'drawer-parts-list' },
        ...sortedParts.map(p => {
          const href = safeHref(p.url);
          const domain = p.domain || domainFromUrl(p.url) || 'link';
          return h('li', { class: 'drawer-part-item' },
            h('span', { class: 'drawer-part-domain' }, domain),
            href
              ? h('a', { class: 'drawer-part-name', href, target: '_blank', rel: 'noopener noreferrer' }, p.name)
              : h('span', { class: 'drawer-part-name' }, p.name),
            h('button', {
              class: 'drawer-part-receive',
              type: 'button',
              title: 'Mark as received (adds a comment)',
              onclick: () => {
                wsSend({ type: 'boardReceivePart', entryId: entry.id, partId: p.id });
              },
            }, '✓ Received'),
            h('button', {
              class: 'drawer-part-remove',
              type: 'button',
              title: 'Remove part',
              'aria-label': 'Remove part',
              onclick: () => {
                if (confirm(`Remove "${p.name}" from parts on order?`)) {
                  wsSend({ type: 'boardRemovePart', entryId: entry.id, partId: p.id });
                }
              },
            }, '×'),
          );
        }),
      );
  const partsSection = h('div', { class: 'drawer-section' },
    h('h4', {}, `Parts ordered (${sortedParts.length})`),
    partsList,
    h('div', { class: 'drawer-part-form' },
      partNameInput,
      partUrlInput,
      h('button', { class: 'btn btn-primary btn-sm-top', type: 'button', onclick: submitPart }, 'Add part'),
    ),
  );

  const deleteBtn = h('button', {
    class: 'btn btn-ghost btn-sm-top drawer-delete',
    type: 'button',
    onclick: () => {
      if (confirm('Delete this card from the board? This cannot be undone.')) {
        wsSend({ type: 'boardDeleteEntry', entryId: entry.id });
        closeDrawer();
      }
    },
  }, 'Delete card');

  // Attachments banner at the bottom of the modal — one tile per PDF
  // (receipt + each invoice). Newest first. Each tile is a link that opens
  // the PDF inline in a new tab; a small download icon forces download.
  const attachmentsBanner = renderAttachmentsBanner(entry);

  // Centered modal with two-column layout: details on the left, parts +
  // comments on the right. Replaces the old right-hand drawer.
  const overlay = h('div', {
    class: 'modal-overlay',
    onclick: (ev) => { if (ev.target === ev.currentTarget) closeDrawer(); },
  },
    h('div', { class: 'modal-panel', role: 'dialog', 'aria-label': 'Job card' },
      h('div', { class: 'drawer-head' },
        h('div', { class: 'drawer-head-left' },
          h('div', { class: 'drawer-emoji' }, entry.deviceEmoji || '💻'),
          h('div', {},
            h('div', { class: 'drawer-title' }, entry.customerName || '—'),
            h('div', { class: 'drawer-sub' }, `#${entry.displayNumber ?? entry.jobId} · ${entry.deviceModel || 'No device'}`),
          ),
        ),
        h('button', { class: 'drawer-close', type: 'button', onclick: closeDrawer }, '×'),
      ),
      h('div', { class: 'modal-cols' },
        // LEFT column — job details, status, password, description.
        h('div', { class: 'modal-col modal-col-left' },
          h('div', { class: 'drawer-section' },
            h('h4', {}, 'Status'),
            statusSelect,
          ),
          h('div', { class: 'drawer-section' },
            h('div', { class: 'drawer-section-head' },
              h('h4', {}, 'Details'),
              detailsToggleBtn,
            ),
            meta,
          ),
          h('div', { class: 'drawer-section' },
            h('h4', {}, 'Where is the device?'),
            intentPicker,
          ),
          passwordSection,
          descSection,
          h('div', { class: 'drawer-foot' }, deleteBtn),
        ),
        // RIGHT column — parts + comments (the operational activity feed).
        h('div', { class: 'modal-col modal-col-right' },
          partsSection,
          h('div', { class: 'drawer-section' },
            h('h4', {}, `Comments (${entry.comments?.length || 0})`),
            commentList,
            h('div', { class: 'drawer-comment-form' },
              commentInput,
              h('div', { class: 'drawer-comment-actions' },
                h('span', { class: 'drawer-comment-hint' }, `Posting as ${me?.name || '…'}  ·  ⌘↵ to send`),
                h('button', { class: 'btn btn-primary', type: 'button', onclick: submitComment }, 'Post comment'),
              ),
            ),
          ),
        ),
      ),
      attachmentsBanner,
    ),
  );
  $drawer.replaceChildren(overlay);
}

// ── Attachments banner ─────────────────────────────────────────────────
// PDFs attached to this job (the receipt generated at checkout + each Xero
// invoice). Tiles link to the inline-view route; the download button forces
// a file save. Empty state: a single "No attachments yet" tile.
function renderAttachmentsBanner(entry) {
  const attachments = (entry.attachments || []).slice().sort((a, b) => {
    const ta = Date.parse(a.createdAt) || 0;
    const tb = Date.parse(b.createdAt) || 0;
    return tb - ta;
  });
  const title = h('div', { class: 'modal-attach-title' },
    `📎 Attachments${attachments.length ? ` (${attachments.length})` : ''}`,
  );
  if (attachments.length === 0) {
    return h('div', { class: 'modal-attach-banner' },
      title,
      h('div', { class: 'modal-attach-empty' }, 'No PDFs saved to this job yet.'),
    );
  }
  return h('div', { class: 'modal-attach-banner' },
    title,
    h('div', { class: 'modal-attach-scroll' },
      ...attachments.map(a => renderAttachmentTile(entry.id, a)),
    ),
  );
}

function renderAttachmentTile(entryId, a) {
  const base = `/api/board/${encodeURIComponent(entryId)}/attachments/${encodeURIComponent(a.id)}`;
  const kindIcon = a.kind === 'receipt' ? '🧾' : '💸';
  return h('div', { class: 'modal-attach-tile' },
    h('a', {
      class: 'modal-attach-link',
      href: `${base}?inline=1`,
      target: '_blank',
      rel: 'noopener',
      title: `View ${a.name}`,
    },
      h('span', { class: 'modal-attach-icon' }, kindIcon),
      h('div', { class: 'modal-attach-meta' },
        h('div', { class: 'modal-attach-name' }, a.name),
        h('div', { class: 'modal-attach-sub' }, `${a.filename} · ${fmtBytes(a.size)}`),
      ),
    ),
    h('a', {
      class: 'modal-attach-download',
      href: base,
      // No target="_blank" — the attachment Content-Disposition triggers
      // a download, so we want to stay on the page.
      download: a.filename,
      title: 'Download',
      'aria-label': 'Download',
    }, '⬇'),
  );
}

function fmtBytes(n) {
  const v = Number(n) || 0;
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / 1024 / 1024).toFixed(1)} MB`;
}

function metaRow(label, value) {
  return h('div', { class: 'drawer-meta-row' },
    h('span', { class: 'drawer-meta-label' }, label),
    h('span', { class: 'drawer-meta-value' }, value),
  );
}

// Row with an inline input — used only while editDetailsMode is true. Writes
// to editDraft on every keystroke so the draft survives a mid-edit re-render
// caused by board state pushes.
function editableRow(label, field, type = 'text') {
  const input = h('input', {
    type,
    class: 'drawer-meta-input',
    value: editDraft[field] ?? '',
  });
  input.addEventListener('input', () => { editDraft[field] = input.value; });
  return h('div', { class: 'drawer-meta-row drawer-meta-row-edit' },
    h('span', { class: 'drawer-meta-label' }, label),
    input,
  );
}

function buildEditableMeta(entry) {
  return h('div', { class: 'drawer-meta' },
    editableRow('Customer', 'customerName'),
    editableRow('Email', 'customerEmail', 'email'),
    editableRow('Phone', 'customerPhone', 'tel'),
    // Flow is derived at intake — not user-editable here.
    metaRow('Flow', flowLabel(entry.flow)),
    editableRow('Device', 'deviceModel'),
    metaRow('Invoices', (entry.invoiceNumbers || []).join(', ') || '—'),
    metaRow('Amount due', fmtAUD(entry.amountDueToday)),
    metaRow('Paid', `${fmtAUD(entry.amountPaid)} · ${methodLabel(entry.paymentMethod)}`),
    metaRow('Booked by', entry.createdBy?.name || '—'),
    metaRow('Created', fmtAbs(entry.createdAt)),
    metaRow('Last updated', fmtAbs(entry.updatedAt)),
  );
}

// Diff the draft against the entry and send one updateEntry message per
// changed field. Exit edit mode on completion — the server will broadcast
// the new state back and refresh the drawer.
function saveDetailEdits(entry) {
  const changes = [];
  const fields = ['customerName', 'customerEmail', 'customerPhone', 'deviceModel'];
  for (const f of fields) {
    const next = String(editDraft[f] ?? '').trim();
    const prev = String(entry[f] ?? '').trim();
    if (next !== prev) changes.push({ field: f, value: next });
  }
  for (const c of changes) {
    wsSend({ type: 'boardUpdateEntry', entryId: entry.id, field: c.field, value: c.value });
  }
  editDetailsMode = false;
  editDraft = {};
  renderDrawer(entry);
}

// Comment block — either a read-only card with edit/delete buttons or an
// inline edit form when editingCommentId matches this comment.
function renderComment(entry, c) {
  if (editingCommentId === c.id) {
    const textarea = h('textarea', {
      class: 'drawer-comment-input',
      rows: '3',
    });
    textarea.value = c.body;
    const cancel = () => { editingCommentId = null; renderDrawer(entry); };
    const save = () => {
      const body = textarea.value.trim();
      if (!body) { cancel(); return; }
      if (body !== c.body) {
        wsSend({ type: 'boardEditComment', entryId: entry.id, commentId: c.id, body });
      }
      editingCommentId = null;
      renderDrawer(entry);
    };
    textarea.addEventListener('keydown', (ev) => {
      if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') { ev.preventDefault(); save(); }
      if (ev.key === 'Escape') { ev.preventDefault(); cancel(); }
    });
    return h('div', { class: 'drawer-comment drawer-comment-editing' },
      h('div', { class: 'drawer-comment-meta' },
        h('strong', {}, c.author?.name || 'Unknown'),
        ' · editing',
      ),
      textarea,
      h('div', { class: 'drawer-comment-actions' },
        h('span', { class: 'drawer-comment-hint' }, '⌘↵ save · esc cancel'),
        h('div', { style: 'display:flex;gap:8px' },
          h('button', { class: 'btn btn-ghost btn-sm-top', type: 'button', onclick: cancel }, 'Cancel'),
          h('button', { class: 'btn btn-primary btn-sm-top', type: 'button', onclick: save }, 'Save'),
        ),
      ),
    );
  }
  return h('div', { class: 'drawer-comment' },
    h('div', { class: 'drawer-comment-meta' },
      h('strong', {}, c.author?.name || 'Unknown'),
      ' · ',
      h('span', { class: 'drawer-comment-time', title: fmtAbs(c.createdAt) }, fmtRelative(c.createdAt)),
      c.editedAt
        ? h('span', { class: 'drawer-comment-edited', title: `Edited ${fmtAbs(c.editedAt)}` }, ' · edited')
        : null,
      h('span', { class: 'drawer-comment-tools' },
        h('button', {
          class: 'drawer-comment-tool-btn',
          type: 'button',
          title: 'Edit comment',
          'aria-label': 'Edit comment',
          onclick: () => { editingCommentId = c.id; renderDrawer(entry); },
        }, '✎'),
        h('button', {
          class: 'drawer-comment-tool-btn',
          type: 'button',
          title: 'Delete comment',
          'aria-label': 'Delete comment',
          onclick: () => {
            if (confirm('Delete this comment?')) {
              wsSend({ type: 'boardDeleteComment', entryId: entry.id, commentId: c.id });
            }
          },
        }, '×'),
      ),
    ),
    h('div', { class: 'drawer-comment-body' }, c.body),
  );
}

// ── Global keyboard ───────────────────────────────────────────────────────
document.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    if (openEntryId) { closeDrawer(); return; }
    if (document.activeElement === $search && $search?.value) {
      $search.value = '';
      searchQuery = '';
      render();
    }
  }
});

// ── Search ────────────────────────────────────────────────────────────────
if ($search) {
  $search.addEventListener('input', () => {
    searchQuery = $search.value;
    render();
  });
}

// ── Boot ──────────────────────────────────────────────────────────────────
async function boot() {
  try {
    const r = await fetch('/api/me', { credentials: 'same-origin' });
    const data = await r.json();
    me = data.user ?? null;
    $meName.textContent = me?.name ?? '';
  } catch {
    $meName.textContent = '';
  }
  render();
  connectWs();
}

boot();
