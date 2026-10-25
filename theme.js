'use strict';

// Disable document.cookie for this page: reads return '' and writes are ignored.
try {
  Object.defineProperty(document, 'cookie', { get: () => '', set: () => {}, configurable: false });
} catch { /* already locked down */ }

// ---------- Theme ----------
const THEME_KEY = 'nota-theme';

function applyTheme(theme) {
  if (theme) document.documentElement.dataset.theme = theme;
  else delete document.documentElement.dataset.theme;
}

function currentTheme() {
  const explicit = document.documentElement.dataset.theme;
  if (explicit) return explicit;
  return matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem(THEME_KEY, next); } catch { /* storage unavailable */ }
}

try { applyTheme(localStorage.getItem(THEME_KEY)); } catch { /* storage unavailable */ }

document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('btn-theme');
  if (btn) btn.addEventListener('click', toggleTheme);
});

// True when a key press should be left alone: typing in a field, or a modifier key held
function isTypingOrModified(e) {
  return e.metaKey || e.ctrlKey || e.altKey || e.target.closest('input, textarea, select, [contenteditable]');
}

// D: toggle light/dark (on every page, also while an overlay is open)
document.addEventListener('keydown', (e) => {
  if (e.key.toLowerCase() === 'd' && !isTypingOrModified(e)) toggleTheme();
});
