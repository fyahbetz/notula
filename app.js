'use strict';

// ---------- IndexedDB ----------
// Internal ids keep the original name "nota" (database, storage keys, backup format),
// so existing notes and backups keep working after the rename to Notula.
const DB_NAME = 'nota';
const STORE = 'notes';
const META = 'meta'; // small key/value store, e.g. the unsaved draft of a new note

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id' }).createIndex('createdAt', 'createdAt');
      }
      if (!db.objectStoreNames.contains(META)) db.createObjectStore(META);
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function tx(db, mode, fn, storeName = STORE) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const result = fn(t.objectStore(storeName));
    t.oncomplete = () => resolve(result && 'result' in result ? result.result : undefined);
    t.onerror = () => reject(t.error);
  });
}

const getAll = (db) => tx(db, 'readonly', (s) => s.getAll());
const putNote = (db, note) => tx(db, 'readwrite', (s) => s.put(note));
const deleteNote = (db, id) => tx(db, 'readwrite', (s) => s.delete(id));
const getMeta = (db, key) => tx(db, 'readonly', (s) => s.get(key), META);
const setMeta = (db, key, value) => tx(db, 'readwrite', (s) => s.put(value, key), META);
const deleteMeta = (db, key) => tx(db, 'readwrite', (s) => s.delete(key), META);

// Notes are shown by `order` (smaller first). New notes go on top; dragging a note changes only its order.
const byOrder = (a, b) => (a.order - b.order) || b.createdAt.localeCompare(a.createdAt);

// Gives an order to notes that have none (older versions, old backups): newest on top
async function ensureOrder() {
  const all = await getAll(db);
  const missing = all.filter((n) => !Number.isFinite(n.order));
  if (!missing.length) return;
  const known = all.filter((n) => Number.isFinite(n.order)).map((n) => n.order);
  const top = Math.min(0, ...known);
  missing.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  missing.forEach((n, i) => { n.order = top - missing.length + i; });
  await tx(db, 'readwrite', (s) => { missing.forEach((n) => s.put(n)); });
}

// Runs fn once `ms` after the last call; flush() runs a pending call right away
function debounce(fn, ms) {
  let timer = null;
  const run = () => { timer = null; fn(); };
  return {
    call() { clearTimeout(timer); timer = setTimeout(run, ms); },
    flush() { if (timer) { clearTimeout(timer); run(); } },
  };
}

function newId() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return Date.now().toString(36) + '-' + Array.from(crypto.getRandomValues(new Uint8Array(8)), (b) => b.toString(16).padStart(2, '0')).join('');
}

// ---------- UI ----------
const $ = (sel) => document.querySelector(sel);
const form = $('#note-form');
const titleEl = $('#note-title');
const bodyEl = $('#note-body');
const saveBtn = $('#btn-save');
const cancelBtn = $('#btn-cancel');
const board = $('#board');
const empty = $('#empty');
const tpl = $('#note-tpl');
const COLORS = ['yellow', 'pink', 'blue', 'green', 'gray'];

const dateFmt = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium', timeStyle: 'short' });

let db;
let editingId = null;

// ---------- Calendar ----------
const calendar = $('#calendar');
const calBtn = $('#btn-calendar');
const calGrid = $('#cal-grid');
const calMonth = $('#cal-month');
const filterBar = $('#filter-bar');
const filterLabel = $('#filter-label');

const monthFmt = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric' });
const dayFmt = new Intl.DateTimeFormat('en-GB', { dateStyle: 'medium' });
const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

const today = new Date();
let viewYear = today.getFullYear();
let viewMonth = today.getMonth();
// null = all notes, { day: 'YYYY-MM-DD' } or { month: 'YYYY-MM' }
let filter = null;

const pad = (n) => String(n).padStart(2, '0');
const monthKey = (y, m) => `${y}-${pad(m + 1)}`;
const dayKey = (y, m, d) => `${monthKey(y, m)}-${pad(d)}`;

// Local-time day key of a note, so a note written at 00:30 belongs to that day
function noteDayKey(note) {
  const d = new Date(note.createdAt);
  return dayKey(d.getFullYear(), d.getMonth(), d.getDate());
}

function matchesFilter(note) {
  if (!filter) return true;
  const key = noteDayKey(note);
  return filter.day ? key === filter.day : key.startsWith(filter.month + '-');
}

function renderCalendar(notes) {
  const daysWithNotes = new Set(notes.map(noteDayKey));
  calMonth.textContent = monthFmt.format(new Date(viewYear, viewMonth, 1));
  calMonth.classList.toggle('selected', !!filter && filter.month === monthKey(viewYear, viewMonth));

  const cells = WEEKDAYS.map((w) => {
    const el = document.createElement('span');
    el.className = 'cal-weekday';
    el.textContent = w;
    return el;
  });
  const offset = (new Date(viewYear, viewMonth, 1).getDay() + 6) % 7; // Monday first
  for (let i = 0; i < offset; i++) cells.push(document.createElement('span'));

  const todayKey = dayKey(today.getFullYear(), today.getMonth(), today.getDate());
  const daysInMonth = new Date(viewYear, viewMonth + 1, 0).getDate();
  for (let d = 1; d <= daysInMonth; d++) {
    const key = dayKey(viewYear, viewMonth, d);
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'cal-day';
    btn.textContent = d;
    btn.classList.toggle('today', key === todayKey);
    btn.classList.toggle('has-notes', daysWithNotes.has(key));
    btn.classList.toggle('selected', !!filter && filter.day === key);
    btn.addEventListener('click', () => pickFilter(filter && filter.day === key ? null : { day: key }));
    cells.push(btn);
  }
  calGrid.replaceChildren(...cells);
}

function renderFilterBar(count) {
  calBtn.classList.toggle('active', !!filter);
  filterBar.hidden = !filter;
  if (!filter) return;
  const [y, m, d] = (filter.day || filter.month).split('-').map(Number);
  const label = filter.day ? dayFmt.format(new Date(y, m - 1, d)) : monthFmt.format(new Date(y, m - 1, 1));
  filterLabel.textContent = `Showing ${count} ${count === 1 ? 'note' : 'notes'} · ${label}`;
}

function openCalendar() {
  // Start from the filtered month, if any, otherwise from today
  const ref = filter && (filter.day || filter.month);
  const d = ref ? new Date(Number(ref.slice(0, 4)), Number(ref.slice(5, 7)) - 1, 1) : today;
  viewYear = d.getFullYear();
  viewMonth = d.getMonth();
  calendar.showModal();
  calBtn.setAttribute('aria-expanded', 'true');
  render();
}

function pickFilter(next) {
  filter = next;
  page = 0;
  calendar.close();
  render();
}

function clearFilter() {
  filter = null;
  page = 0;
  render();
}

function shiftMonth(delta) {
  const d = new Date(viewYear, viewMonth + delta, 1);
  viewYear = d.getFullYear();
  viewMonth = d.getMonth();
  render();
}

calBtn.addEventListener('click', openCalendar);
calendar.addEventListener('close', () => calBtn.setAttribute('aria-expanded', 'false'));
// Clicks on the blurred background land on the dialog element itself
calendar.addEventListener('click', (e) => { if (e.target === calendar) calendar.close(); });
$('#cal-prev').addEventListener('click', () => shiftMonth(-1));
$('#cal-next').addEventListener('click', () => shiftMonth(1));
calMonth.addEventListener('click', () => {
  const key = monthKey(viewYear, viewMonth);
  pickFilter(filter && filter.month === key ? null : { month: key });
});
$('#filter-clear').addEventListener('click', clearFilter);
// Esc on the board (no overlay open) also goes back to all notes
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && filter && !document.querySelector('dialog[open]')) clearFilter();
});

// ---------- Pagination ----------
const PAGE_SIZE = 24; // fills rows evenly with 1, 2, 3, 4 or 6 columns
const pager = $('#pager');
let page = 0;

function renderPager(pages) {
  pager.hidden = pages <= 1;
  $('#page-label').textContent = `${page + 1} / ${pages}`;
  $('#page-prev').disabled = page === 0;
  $('#page-next').disabled = page >= pages - 1;
}

function goToPage(delta) {
  page += delta;
  render();
  window.scrollTo({ top: 0, behavior: reducedMotion.matches ? 'auto' : 'smooth' });
}

$('#page-prev').addEventListener('click', () => goToPage(-1));
$('#page-next').addEventListener('click', () => goToPage(1));

// ---------- Welcome screen (shown while there are no notes) ----------
const welcome = $('#welcome');
let welcomeDismissed = false;

function renderWelcome(all) {
  const show = all.length === 0 && !welcomeDismissed;
  welcome.hidden = !show;
  document.body.classList.toggle('welcome-mode', show);
}

$('#welcome-start').addEventListener('click', () => {
  welcomeDismissed = true;
  welcome.classList.add('fade-out');
  setTimeout(async () => {
    welcome.classList.remove('fade-out');
    document.body.classList.add('fade-in');
    await render();
    openCompose();
  }, 200);
});
$('#welcome-import').addEventListener('click', () => fileInput.click());

async function render() {
  const all = (await getAll(db)).sort(byOrder);
  const notes = all.filter(matchesFilter);
  renderWelcome(all);
  document.body.classList.remove('booting');
  if (calendar.open) renderCalendar(all);
  renderFilterBar(notes.length);
  renderBackupStatus(all);
  board.replaceChildren();
  empty.hidden = notes.length > 0;
  empty.textContent = all.length === 0 ? 'No notes yet. Press + to add one.' : 'No notes for this date.';
  // The focus view can move through all matching notes, the board shows one page of them
  visibleNotes = notes;
  const pages = Math.max(1, Math.ceil(notes.length / PAGE_SIZE));
  page = Math.min(Math.max(page, 0), pages - 1);
  renderPager(pages);
  for (const note of notes.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE)) {
    const el = tpl.content.firstElementChild.cloneNode(true);
    fillNote(el, note);
    el.dataset.id = note.id;
    el.tabIndex = 0;
    el.querySelector('.edit').addEventListener('click', () => startEdit(note));
    el.querySelector('.delete').addEventListener('click', () => removeNote(note));
    el.addEventListener('click', (e) => {
      if (!suppressClick && !e.target.closest('button')) openFocus(note);
    });
    el.addEventListener('keydown', (e) => {
      if (e.target === el && (e.key === 'Enter' || e.key === ' ')) {
        e.preventDefault();
        openFocus(note);
      }
    });
    board.append(el);
  }
}

function fillNote(el, note) {
  el.classList.remove(...COLORS);
  el.classList.add(COLORS.includes(note.color) ? note.color : 'yellow');
  el.querySelector('.note-title').textContent = note.title;
  el.querySelector('.note-body').textContent = note.body;
  const time = el.querySelector('.note-date');
  time.dateTime = note.createdAt;
  time.textContent = dateFmt.format(new Date(note.createdAt));
  time.title = note.updatedAt && note.updatedAt !== note.createdAt
    ? 'Edited: ' + dateFmt.format(new Date(note.updatedAt))
    : '';
}

// ---------- Focus view: one note enlarged in the middle of the screen ----------
const focusDialog = $('#focus-dialog');
const focusNote = $('#focus-note');
const focusTitle = $('#focus-title');
const focusBody = $('#focus-body');
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
let visibleNotes = [];
let focusIndex = -1;
let focusClosing = false;
let focusDirty = false; // a note was edited in the focus view; the board needs a refresh

function fillFocus(note) {
  focusNote.classList.remove(...COLORS);
  focusNote.classList.add(COLORS.includes(note.color) ? note.color : 'yellow');
  focusTitle.value = note.title;
  focusBody.value = note.body;
  const radio = focusNote.querySelector(`input[name="focus-color"][value="${note.color}"]`);
  if (radio) radio.checked = true;
  focusBody.scrollTop = 0;
  const time = focusNote.querySelector('.note-date');
  time.dateTime = note.createdAt;
  time.textContent = dateFmt.format(new Date(note.createdAt));
  time.title = note.updatedAt && note.updatedAt !== note.createdAt
    ? 'Edited: ' + dateFmt.format(new Date(note.updatedAt))
    : '';
  growTitle();
}

function growTitle() {
  focusTitle.style.height = 'auto';
  focusTitle.style.height = focusTitle.scrollHeight + 'px';
}

// Saves title/text edited in the focus view. An empty title is not allowed: the old one is kept.
// `final` is false while typing: an empty title is then left alone (you may be retyping it)
async function saveFocus({ final = true } = {}) {
  const note = visibleNotes[focusIndex];
  if (!note) return;
  if (final && !focusTitle.value.trim()) { focusTitle.value = note.title; growTitle(); }
  const title = focusTitle.value.trim() || note.title;
  const body = focusBody.value;
  if (title === note.title && body === note.body) return;
  const updated = { ...note, title, body, updatedAt: new Date().toISOString() };
  visibleNotes[focusIndex] = updated;
  focusDirty = true;
  await putNote(db, updated);
}

const autoSaveFocus = debounce(() => saveFocus({ final: false }), 500);

focusTitle.addEventListener('input', () => { growTitle(); autoSaveFocus.call(); });
focusBody.addEventListener('input', () => autoSaveFocus.call());
focusTitle.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); focusBody.focus(); }
});
focusTitle.addEventListener('change', saveFocus);
focusBody.addEventListener('change', saveFocus);

const boardNoteEl = (id) => board.querySelector(`.note[data-id="${CSS.escape(id)}"]`);

// Transform that makes the box `to` look like the box `from` (FLIP animation)
function flipFrom(from, to) {
  const dx = from.left + from.width / 2 - (to.left + to.width / 2);
  const dy = from.top + from.height / 2 - (to.top + to.height / 2);
  return `translate(${dx}px, ${dy}px) scale(${from.width / to.width}, ${from.height / to.height})`;
}

const FOCUS_ANIM = { duration: 260, easing: 'cubic-bezier(.2, .8, .2, 1)' };

function openFocus(note) {
  focusIndex = visibleNotes.findIndex((n) => n.id === note.id);
  focusDialog.showModal();
  fillFocus(note);
  focusNote.focus();
  const src = boardNoteEl(note.id);
  if (src && !reducedMotion.matches) {
    const transform = flipFrom(src.getBoundingClientRect(), focusNote.getBoundingClientRect());
    focusNote.animate([{ transform }, { transform: 'none' }], FOCUS_ANIM);
  }
}

async function closeFocus({ animate = true } = {}) {
  if (!focusDialog.open || focusClosing) return;
  await saveFocus();
  // If you moved to a note on another page, show that page so the note can fly back into place
  const notePage = Math.floor(focusIndex / PAGE_SIZE);
  if (focusIndex >= 0 && notePage !== page) {
    page = notePage;
    focusDirty = false;
    await render();
  }
  const note = visibleNotes[focusIndex];
  const src = note && boardNoteEl(note.id);
  if (animate && src && !reducedMotion.matches) {
    focusClosing = true;
    focusDialog.classList.add('closing');
    const transform = flipFrom(src.getBoundingClientRect(), focusNote.getBoundingClientRect());
    const anim = focusNote.animate([{ transform: 'none' }, { transform }], { ...FOCUS_ANIM, duration: 220 });
    // Never wait forever: browsers can pause animations (e.g. in a background tab)
    await Promise.race([anim.finished, new Promise((r) => setTimeout(r, 300))]);
    focusDialog.classList.remove('closing');
    focusClosing = false;
  }
  focusDialog.close();
  if (focusDirty) {
    focusDirty = false;
    await render();
  }
}

async function stepFocus(delta) {
  const next = focusIndex + delta;
  if (next < 0 || next >= visibleNotes.length) return;
  await saveFocus();
  focusIndex = next;
  fillFocus(visibleNotes[next]);
  if (!reducedMotion.matches) {
    focusNote.animate(
      [{ opacity: 0, transform: `translateX(${delta * 16}px)` }, { opacity: 1, transform: 'none' }],
      { duration: 180, easing: 'ease-out' },
    );
  }
}

focusDialog.addEventListener('cancel', (e) => { e.preventDefault(); closeFocus(); });
focusDialog.addEventListener('click', (e) => { if (e.target === focusDialog) closeFocus(); });
focusDialog.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') { e.preventDefault(); closeFocus(); }
  // Arrows and ⌘⌫ edit text while typing; outside the text fields they switch or delete notes
  if (e.target.matches('textarea')) return;
  if (e.key === 'Backspace' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault();
    focusNote.querySelector('.delete').click();
    return;
  }
  if (e.key === 'ArrowLeft') stepFocus(-1);
  if (e.key === 'ArrowRight') stepFocus(1);
});
$('#focus-close').addEventListener('click', () => closeFocus());
// Changing the color in the focus view applies and saves it right away
$('#focus-colors').addEventListener('change', async (e) => {
  const note = visibleNotes[focusIndex];
  if (!note || !COLORS.includes(e.target.value)) return;
  focusNote.classList.remove(...COLORS);
  focusNote.classList.add(e.target.value);
  const updated = { ...note, color: e.target.value, updatedAt: new Date().toISOString() };
  visibleNotes[focusIndex] = updated;
  focusDirty = true;
  await putNote(db, updated);
});
focusNote.querySelector('.delete').addEventListener('click', async () => {
  if (await removeNote(visibleNotes[focusIndex])) closeFocus({ animate: false });
});

function setColor(color) {
  const radio = form.querySelector(`input[name="color"][value="${color}"]`);
  if (radio) radio.checked = true;
}

// ---------- Compose dialog (new note / edit note) ----------
const compose = $('#compose');

function syncFormColor() {
  form.classList.remove(...COLORS);
  form.classList.add(form.elements.color.value);
}

const composeDate = $('#compose-date');

// While a day is selected in the calendar, new notes are dated that day
function selectedDayDate() {
  if (!filter || !filter.day) return null;
  const [y, m, d] = filter.day.split('-').map(Number);
  const now = new Date();
  return new Date(y, m - 1, d, now.getHours(), now.getMinutes(), now.getSeconds());
}

function openCompose() {
  const day = !editingId && selectedDayDate();
  composeDate.hidden = !day;
  if (day) composeDate.textContent = 'For ' + dayFmt.format(day);
  if (!compose.open) compose.showModal();
  titleEl.focus();
}

// Unsaved new note, kept in IndexedDB so it survives a reload or closing the app
let draft = null;

const saveDraft = debounce(() => {
  if (draft) setMeta(db, 'draft', draft);
  else deleteMeta(db, 'draft');
}, 400);

function updateDraft() {
  if (editingId) return; // editing an existing note is not a draft
  const title = titleEl.value;
  const body = bodyEl.value;
  draft = title.trim() || body.trim() ? { title, body, color: form.elements.color.value } : null;
  saveDraft.call();
}

function clearDraft() {
  draft = null;
  saveDraft.call();
  saveDraft.flush();
}

// Back to "new note" mode, showing the draft if there is one
function resetForm() {
  editingId = null;
  form.reset();
  if (draft) {
    titleEl.value = draft.title;
    bodyEl.value = draft.body;
    setColor(draft.color);
  }
  syncFormColor();
  saveBtn.textContent = 'Add';
}

function startEdit(note) {
  editingId = note.id;
  titleEl.value = note.title;
  bodyEl.value = note.body;
  setColor(note.color);
  syncFormColor();
  saveBtn.textContent = 'Save';
  openCompose();
}

$('#btn-add').addEventListener('click', openCompose);
form.addEventListener('change', (e) => {
  if (e.target.name === 'color') { syncFormColor(); updateDraft(); }
});
form.addEventListener('input', updateDraft);
// Closing with Esc or a click outside keeps an unsaved new note as a draft, but abandons an edit
compose.addEventListener('close', () => { if (editingId) resetForm(); });
compose.addEventListener('click', (e) => { if (e.target === compose) compose.close(); });
form.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); form.requestSubmit(); }
});

// When an overlay closes, the browser puts the focus back on the note or button that opened it,
// which then shows a focus ring. Drop that focus instead.
for (const dlg of [compose, calendar, focusDialog, $('#ask'), $('#shortcuts')]) {
  dlg.addEventListener('close', () => {
    setTimeout(() => { if (!document.querySelector('dialog[open]')) document.activeElement?.blur(); });
  });
}

// Esc closes overlays explicitly, so it behaves the same in every browser
const shortcutsDialog = $('#shortcuts');
for (const dlg of [compose, calendar, shortcutsDialog]) {
  dlg.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { e.preventDefault(); dlg.close(); }
  });
}
shortcutsDialog.addEventListener('click', (e) => { if (e.target === shortcutsDialog) shortcutsDialog.close(); });
$('#shortcuts-close').addEventListener('click', () => shortcutsDialog.close());

// ---------- Keyboard shortcuts on the board ----------
document.addEventListener('keydown', (e) => {
  if (isTypingOrModified(e) || drag || document.querySelector('dialog[open]')) return;
  const k = e.key.toLowerCase();
  if (document.body.classList.contains('welcome-mode')) {
    if (k === 'n') { e.preventDefault(); $('#welcome-start').click(); }
    return;
  }
  if (k === 'n') { e.preventDefault(); openCompose(); }
  else if (k === 'c') { e.preventDefault(); openCalendar(); }
  else if (e.key === '?') { e.preventDefault(); shortcutsDialog.showModal(); }
  else if (e.key === 'ArrowLeft' && !pager.hidden && page > 0) goToPage(-1);
  else if (e.key === 'ArrowRight' && !pager.hidden && !$('#page-next').disabled) goToPage(1);
});

// ---------- Confirm / message dialog (replaces the browser's own popups) ----------
const askDialog = $('#ask');

// Resolves true for the main button, false for Cancel, Esc or a click outside.
// Pass cancel: null for a simple message with only an OK button.
function ask({ title, message = '', ok = 'OK', cancel = 'Cancel', danger = false }) {
  return new Promise((resolve) => {
    const okBtn = $('#ask-ok');
    const cancelBtnAsk = $('#ask-cancel');
    $('#ask-title').textContent = title;
    $('#ask-message').textContent = message;
    $('#ask-message').hidden = !message;
    okBtn.textContent = ok;
    okBtn.classList.toggle('danger', danger);
    cancelBtnAsk.hidden = !cancel;
    if (cancel) cancelBtnAsk.textContent = cancel;
    let result = false;
    const finish = (value) => { result = value; askDialog.close(); };
    okBtn.onclick = () => finish(true);
    cancelBtnAsk.onclick = () => finish(false);
    askDialog.onclick = (e) => { if (e.target === askDialog) finish(false); };
    askDialog.onkeydown = (e) => { if (e.key === 'Escape') { e.preventDefault(); finish(false); } };
    askDialog.addEventListener('close', () => resolve(result), { once: true });
    askDialog.showModal();
    // Safer default: Enter cancels a destructive action
    (cancel ? cancelBtnAsk : okBtn).focus();
  });
}

async function removeNote(note) {
  const confirmed = await ask({
    title: 'Delete this note?',
    message: `“${note.title}” will be deleted. This can't be undone.`,
    ok: 'Delete',
    danger: true,
  });
  if (!confirmed) return false;
  await deleteNote(db, note.id);
  if (editingId === note.id) resetForm();
  render();
  return true;
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  const title = titleEl.value.trim();
  if (!title) return;
  const now = new Date().toISOString();
  const color = form.elements.color.value;
  const all = await getAll(db);
  const existing = editingId && all.find((n) => n.id === editingId);
  const top = Math.min(0, ...all.map((n) => n.order).filter(Number.isFinite));
  const note = existing
    ? { ...existing, title, body: bodyEl.value, color, updatedAt: now }
    : {
      id: newId(), title, body: bodyEl.value, color,
      createdAt: (selectedDayDate() || new Date()).toISOString(), updatedAt: now,
      order: top - 1,
    };
  await putNote(db, note);
  if (!existing) clearDraft();
  resetForm();
  compose.close();
  // Make sure the saved note is visible: drop a filter it does not match, and show the page it is on
  if (!matchesFilter(note)) filter = null;
  if (!existing) page = 0;
  render();
});

cancelBtn.addEventListener('click', () => {
  if (!editingId) clearDraft(); // Cancel on a new note throws the draft away
  resetForm();
  compose.close();
});

// ---------- Encryption (Web Crypto: PBKDF2-SHA256 + AES-256-GCM) ----------
const PBKDF2_ITERATIONS = 600000;

function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}

function fromBase64(str) {
  const s = atob(str);
  const bytes = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) bytes[i] = s.charCodeAt(i);
  return bytes;
}

async function deriveKey(password, salt, iterations) {
  const base = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt, iterations, hash: 'SHA-256' },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

async function encryptPayload(payload, password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await deriveKey(password, salt, PBKDF2_ITERATIONS);
  const plain = new TextEncoder().encode(JSON.stringify(payload));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plain));
  return {
    app: 'nota',
    version: 1,
    encrypted: true,
    kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: PBKDF2_ITERATIONS, salt: toBase64(salt) },
    cipher: { name: 'AES-GCM', iv: toBase64(iv) },
    data: toBase64(cipher),
  };
}

async function decryptPayload(file, password) {
  const iterations = file.kdf && file.kdf.iterations;
  // Bound the iteration count so a crafted file cannot freeze the page
  if (!Number.isInteger(iterations) || iterations < 1000 || iterations > 10000000) {
    throw new Error('unsupported encryption parameters');
  }
  const key = await deriveKey(password, fromBase64(file.kdf.salt), iterations);
  let plain;
  try {
    plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(file.cipher.iv) }, key, fromBase64(file.data));
  } catch {
    return null; // wrong password or tampered file
  }
  return JSON.parse(new TextDecoder().decode(plain));
}

// ---------- Password dialog ----------
const pwDialog = $('#pw-dialog');
const pwForm = $('#pw-form');
const pw1 = $('#pw1');
const pw2 = $('#pw2');
const pwError = $('#pw-error');

// Resolves with the password ('' allowed on export = no encryption), or null if cancelled.
function askPassword({ title, hint, confirm, error = '' }) {
  return new Promise((resolve) => {
    $('#pw-title').textContent = title;
    $('#pw-hint').textContent = hint;
    pwForm.reset();
    pw2.hidden = !confirm;
    pwError.textContent = error;
    pwError.hidden = !error;

    const onSubmit = (e) => {
      e.preventDefault();
      if (confirm && pw1.value !== pw2.value) {
        pwError.textContent = 'Passwords do not match.';
        pwError.hidden = false;
        return;
      }
      if (!confirm && !pw1.value) {
        pwError.textContent = 'Please enter the password.';
        pwError.hidden = false;
        return;
      }
      done(pw1.value);
    };
    const onCancel = () => done(null);
    const onClose = () => done(null);

    function done(value) {
      pwForm.removeEventListener('submit', onSubmit);
      $('#pw-cancel').removeEventListener('click', onCancel);
      pwDialog.removeEventListener('close', onClose);
      if (pwDialog.open) pwDialog.close();
      pwForm.reset();
      resolve(value);
    }

    pwForm.addEventListener('submit', onSubmit);
    $('#pw-cancel').addEventListener('click', onCancel);
    pwDialog.addEventListener('close', onClose);
    pwDialog.showModal();
    pw1.focus();
  });
}

// ---------- Backup reminder ----------
const BACKUP_KEY = 'nota-last-backup';
const BACKUP_REMIND_DAYS = 7;
const backupStatus = $('#backup-status');
const relFmt = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

function getLastBackup() {
  try { return localStorage.getItem(BACKUP_KEY); } catch { return null; }
}

function setLastBackup(iso) {
  try { localStorage.setItem(BACKUP_KEY, iso); } catch { /* storage unavailable */ }
}

function daysSince(iso) {
  const startOfDay = (d) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
  return Math.round((startOfDay(new Date()) - startOfDay(new Date(iso))) / 86400000);
}

function renderBackupStatus(all) {
  const show = all.length > 0;
  backupStatus.hidden = !show;
  $('#backup-sep').hidden = !show;
  if (!show) return;
  const last = getLastBackup();
  if (!last) {
    backupStatus.textContent = 'No backup yet';
    backupStatus.classList.add('warn');
    return;
  }
  const days = daysSince(last);
  const changedSince = all.some((n) => (n.updatedAt || n.createdAt) > last);
  backupStatus.textContent = 'Last backup: ' + relFmt.format(-days, 'day');
  // Only nag when there is something new that the last backup does not contain
  backupStatus.classList.toggle('warn', changedSince && days >= BACKUP_REMIND_DAYS);
}

// ---------- Export / Import ----------
async function exportNotes() {
  const password = await askPassword({
    title: 'Export notes',
    hint: 'Choose a password to encrypt the backup, or leave it empty to export plain JSON. If you forget the password, the backup cannot be recovered.',
    confirm: true,
  });
  if (password === null) return;
  if (password && !(crypto && crypto.subtle)) {
    await ask({ title: 'Encryption not available', message: 'Open the site over https:// or on localhost to export with a password.', cancel: null });
    return;
  }
  const notes = await getAll(db);
  const payload = { app: 'nota', version: 1, exportedAt: new Date().toISOString(), notes };
  const data = password ? await encryptPayload(payload, password) : payload;
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `notula-backup-${new Date().toISOString().slice(0, 10)}.json`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  setLastBackup(payload.exportedAt);
  render();
}

$('#btn-export').addEventListener('click', exportNotes);
backupStatus.addEventListener('click', exportNotes);

const fileInput = $('#file-import');
$('#btn-import').addEventListener('click', () => fileInput.click());

function isValidNote(n) {
  return n && typeof n.id === 'string' && typeof n.title === 'string'
    && typeof n.body === 'string' && typeof n.createdAt === 'string'
    && !Number.isNaN(Date.parse(n.createdAt));
}

fileInput.addEventListener('change', async () => {
  const file = fileInput.files[0];
  fileInput.value = '';
  if (!file) return;
  try {
    let data = JSON.parse(await file.text());
    if (data && data.encrypted) {
      if (!(crypto && crypto.subtle)) {
        throw new Error('decryption is not available here. Open the site over https:// or http://localhost');
      }
      let error = '';
      let decrypted = null;
      while (!decrypted) {
        const password = await askPassword({
          title: 'Import encrypted backup',
          hint: 'This backup is encrypted. Enter its password.',
          confirm: false,
          error,
        });
        if (password === null) return;
        decrypted = await decryptPayload(data, password);
        error = 'Wrong password, or the file is damaged.';
      }
      data = decrypted;
    }
    const incoming = Array.isArray(data) ? data : data.notes;
    if (!Array.isArray(incoming)) throw new Error('unrecognized format');
    const valid = incoming.filter(isValidNote);
    const existing = new Map((await getAll(db)).map((n) => [n.id, n]));
    let added = 0, updated = 0;
    for (const n of valid) {
      const note = {
        id: n.id,
        title: n.title,
        body: n.body,
        color: COLORS.includes(n.color) ? n.color : 'yellow',
        createdAt: n.createdAt,
        updatedAt: typeof n.updatedAt === 'string' ? n.updatedAt : n.createdAt,
        ...(Number.isFinite(n.order) ? { order: n.order } : {}),
      };
      const old = existing.get(note.id);
      // On conflict, the most recently edited version wins
      if (old && old.updatedAt >= note.updatedAt) continue;
      await putNote(db, note);
      old ? updated++ : added++;
    }
    await ensureOrder();
    render();
    await ask({ title: 'Import complete', message: `${added} added, ${updated} updated, ${incoming.length - valid.length} skipped.`, cancel: null });
  } catch (err) {
    await ask({ title: "Couldn't import the file", message: err.message, cancel: null });
  }
});

// ---------- Drag to reorder ----------
// Mouse: press and move a few pixels. Touch: press and hold, then move (a quick swipe still scrolls).
const DRAG_THRESHOLD = 6;
const LONG_PRESS_MS = 450;
let drag = null; // { el, id, pointerId, touch, startX, startY, x, y, grabX, grabY, active, timer }
let suppressClick = false; // the click that follows a drop must not open the focus view

board.addEventListener('pointerdown', (e) => {
  const el = e.target.closest('.note');
  if (!el || drag || e.button !== 0 || e.target.closest('button') || board.children.length < 2) return;
  drag = {
    el, id: el.dataset.id, pointerId: e.pointerId, touch: e.pointerType === 'touch',
    startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, active: false, timer: null,
  };
  if (drag.touch) drag.timer = setTimeout(startDrag, LONG_PRESS_MS);
});

document.addEventListener('pointermove', (e) => {
  if (!drag || e.pointerId !== drag.pointerId) return;
  drag.x = e.clientX;
  drag.y = e.clientY;
  if (!drag.active) {
    const dist = Math.hypot(drag.x - drag.startX, drag.y - drag.startY);
    if (drag.touch && dist > 10) endDrag(); // the finger moved before the long press: it's a scroll
    else if (!drag.touch && dist > DRAG_THRESHOLD) startDrag();
    return;
  }
  moveDrag();
});

document.addEventListener('pointerup', (e) => {
  if (drag && e.pointerId === drag.pointerId) dropDrag();
});
document.addEventListener('pointercancel', (e) => {
  if (drag && e.pointerId === drag.pointerId) endDrag({ restore: true });
});
// While dragging on a touch screen, the finger moves the note, not the page
document.addEventListener('touchmove', (e) => { if (drag && drag.active) e.preventDefault(); }, { passive: false });
board.addEventListener('contextmenu', (e) => { if (drag) e.preventDefault(); });
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && drag && drag.active) endDrag({ restore: true });
});

function startDrag() {
  const { el } = drag;
  const r = el.getBoundingClientRect();
  drag.grabX = drag.startX - r.left;
  drag.grabY = drag.startY - r.top;
  drag.active = true;
  el.classList.add('dragging');
  document.body.classList.add('is-dragging');
  try { el.setPointerCapture(drag.pointerId); } catch { /* not supported */ }
  if (drag.touch && navigator.vibrate) navigator.vibrate(10);
  moveDrag();
}

function moveDrag() {
  const { el } = drag;
  const b = board.getBoundingClientRect();
  // Over another note's slot: take its place, and let the others slide.
  // Slots are found from the layout (offsets), not from where notes are while they animate.
  const px = drag.x - b.left;
  const py = drag.y - b.top;
  const notes = [...board.children];
  const over = notes.find((n) => n !== el
    && px >= n.offsetLeft && px < n.offsetLeft + n.offsetWidth
    && py >= n.offsetTop && py < n.offsetTop + n.offsetHeight);
  if (over) {
    const from = notes.indexOf(el);
    const to = notes.indexOf(over);
    slideOthers(() => (to > from ? over.after(el) : over.before(el)), el);
  }
  // Keep the note under the pointer, wherever its slot is now
  const x = drag.x - b.left - drag.grabX - el.offsetLeft;
  const y = drag.y - b.top - drag.grabY - el.offsetTop;
  el.style.transform = `translate(${x}px, ${y}px) scale(1.04)`;
  // Scroll when dragging near the top or bottom edge
  if (drag.y < 60) window.scrollBy(0, -12);
  else if (drag.y > window.innerHeight - 60) window.scrollBy(0, 12);
}

// Moves DOM nodes and animates the other notes from their old to their new place
function slideOthers(mutate, skip) {
  const others = [...board.children].filter((n) => n !== skip);
  const before = new Map(others.map((n) => [n, n.getBoundingClientRect()]));
  others.forEach((n) => n.getAnimations().forEach((a) => a.cancel()));
  mutate();
  if (reducedMotion.matches) return;
  for (const n of others) {
    const a = before.get(n);
    const c = n.getBoundingClientRect();
    const dx = a.left - c.left;
    const dy = a.top - c.top;
    if (dx || dy) n.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: 180, easing: 'ease-out' });
  }
}

function endDrag({ restore = false } = {}) {
  if (!drag) return;
  clearTimeout(drag.timer);
  const { el, active } = drag;
  drag = null;
  if (!active) return;
  el.classList.remove('dragging');
  el.style.transform = '';
  document.body.classList.remove('is-dragging');
  if (restore) render(); // put everything back where it was
}

async function dropDrag() {
  if (!drag.active) { endDrag(); return; }
  const { el, id } = drag;
  const from = el.style.transform;
  endDrag();
  suppressClick = true;
  setTimeout(() => { suppressClick = false; });
  if (!reducedMotion.matches) el.animate([{ transform: from }, { transform: 'none' }], { duration: 160, easing: 'ease-out' });
  await saveOrder(id);
  render();
}

// Gives the dropped note an order between its new neighbours (only that note is written)
async function saveOrder(id) {
  const start = page * PAGE_SIZE;
  const byId = new Map(visibleNotes.map((n) => [n.id, n]));
  const list = [
    ...visibleNotes.slice(0, start),
    ...[...board.children].map((n) => byId.get(n.dataset.id)),
    ...visibleNotes.slice(start + PAGE_SIZE),
  ];
  const i = list.findIndex((n) => n.id === id);
  if (i === visibleNotes.findIndex((n) => n.id === id)) return; // dropped where it was
  const prev = list[i - 1];
  const next = list[i + 1];
  let order;
  if (prev && next) order = (prev.order + next.order) / 2;
  else if (prev) order = prev.order + 1;
  else order = next.order - 1;
  // After very many moves in the same spot, numbers can run out of precision: renumber everything
  if (prev && next && !(order > prev.order && order < next.order)) {
    await renumber(id, prev.id);
    return;
  }
  await putNote(db, { ...byId.get(id), order });
}

async function renumber(id, afterId) {
  const all = (await getAll(db)).sort(byOrder);
  const moved = all.splice(all.findIndex((n) => n.id === id), 1)[0];
  all.splice(all.findIndex((n) => n.id === afterId) + 1, 0, moved);
  all.forEach((n, i) => { n.order = i; });
  await tx(db, 'readwrite', (s) => { all.forEach((n) => s.put(n)); });
}

// ---------- Privacy screen ----------
// Covers everything (even an open note) with a plain screen. It guards against glances,
// it does not encrypt anything. Opens with the button, with H, when the page is hidden
// (another tab or app) and after a few minutes without activity.
const privacy = $('#privacy');
const IDLE_MS = 5 * 60 * 1000;
let lastActivity = Date.now();

function hideNotes() {
  if (privacy.open || document.body.classList.contains('welcome-mode') || document.body.classList.contains('booting')) return;
  if (drag) endDrag({ restore: true });
  saveNow();
  privacy.showModal();
}

function showNotes() {
  if (!privacy.open) return;
  privacy.close();
  lastActivity = Date.now();
}

$('#btn-hide').addEventListener('click', hideNotes);
privacy.addEventListener('click', showNotes);
privacy.addEventListener('keydown', (e) => {
  e.preventDefault();
  e.stopPropagation(); // the key that reveals the notes must not also trigger a shortcut
  // Ignore modifier keys and combinations (⌘Tab, ⌘W…): only a plain key press reveals
  if (['Meta', 'Control', 'Alt', 'Shift'].includes(e.key) || e.metaKey || e.ctrlKey || e.altKey) return;
  showNotes();
});
privacy.addEventListener('cancel', (e) => e.preventDefault());

// H hides the notes from anywhere, as long as you are not typing
document.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'h' && !isTypingOrModified(e) && !privacy.open) {
    e.preventDefault();
    hideNotes();
  }
});

for (const type of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart', 'scroll']) {
  window.addEventListener(type, () => { lastActivity = Date.now(); }, { passive: true, capture: true });
}
setInterval(() => { if (Date.now() - lastActivity > IDLE_MS) hideNotes(); }, 10000);

// Leaving the page (closing the tab or app, switching away): save right away
function saveNow() {
  if (!db) return;
  saveDraft.flush();
  if (focusDialog.open) saveFocus({ final: false });
}
document.addEventListener('visibilitychange', () => { if (document.hidden) hideNotes(); });
window.addEventListener('pagehide', saveNow);

// ---------- Startup ----------
(async () => {
  try {
    db = await openDB();
    await ensureOrder();
    draft = (await getMeta(db, 'draft')) || null;
    resetForm();
    // Ask the browser not to evict our data when disk space runs low
    if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
    render();
  } catch (err) {
    document.body.classList.remove('booting');
    empty.hidden = false;
    empty.textContent = 'IndexedDB is not available in this browser: ' + err.message;
  }
})();

// Offline support and installability (only works over https:// or on localhost)
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch(() => { /* not available, e.g. opened from disk */ });
}
