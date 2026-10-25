export function h(tag, attrs = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k === 'style' && typeof v === 'object') Object.assign(el.style, v);
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else if (k === 'html') el.innerHTML = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) if (c != null && c !== false) el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  return el;
}
export const $ = (s, r = document) => r.querySelector(s);

let datalistId = 0;
export function datalist(values) {
  const id = 'dl' + (++datalistId);
  const dl = h('datalist', { id }, values.slice(0, 4000).map(v => typeof v === 'string' ? h('option', { value: v }) : h('option', { value: v.value }, v.label)));
  return { id, el: dl };
}

// guard(): return true when the dialog holds unsaved edits — Escape, × and a click beside the dialog then ask first
export function modal({ title, body, buttons = [], wide = false, onClose, guard = null }) {
  const root = document.getElementById('modal-root');
  let closed = false;
  const close = () => { if (closed) return; closed = true; bd.remove(); document.removeEventListener('keydown', esc, true); onClose && onClose(); };
  const dismiss = async () => { if (guard && guard() && !(await confirmDialog('Unsaved changes', 'Close and discard your changes?', 'Discard', true))) return; close(); };
  const top = () => root.lastElementChild === bd; // only the topmost dialog reacts to Escape
  const esc = (e) => { if (e.key === 'Escape' && top()) { e.stopPropagation(); e.preventDefault(); dismiss(); } };
  const footer = h('footer', {}, buttons.map(b => b.el ? b.el : h('button', { class: 'btn ' + (b.cls || ''), onclick: async () => { const r = b.onClick ? await b.onClick() : true; if (r !== false) close(); } }, b.label)));
  const box = h('div', { class: 'modal' + (wide ? ' wide' : '') },
    h('header', {}, h('h2', {}, title), h('button', { class: 'close', onclick: dismiss, title: 'Close' }, '×')),
    h('div', { class: 'body' }, body),
    buttons.length ? footer : null);
  const bd = h('div', { class: 'backdrop', onmousedown: (e) => { if (e.target === bd) dismiss(); } }, box);
  root.append(bd);
  document.addEventListener('keydown', esc, true);
  const first = box.querySelector('input, select, textarea'); if (first) setTimeout(() => first.focus(), 30);
  return { close, box };
}

export function confirmDialog(title, text, okLabel = 'OK', danger = false) {
  return new Promise(res => {
    let done = false;
    modal({ title, body: h('div', { style: { whiteSpace: 'pre-wrap' } }, text), onClose: () => { if (!done) res(false); }, buttons: [{ label: 'Cancel', onClick: () => { done = true; res(false); } }, { label: okLabel, cls: danger ? 'danger primary' : 'primary', onClick: () => { done = true; res(true); } }] });
  });
}
export function promptDialog(title, label, value = '') {
  return new Promise(res => {
    let done = false;
    const inp = h('input', { value, style: { width: '100%' } });
    const m = modal({ title, body: h('div', { class: 'form' }, h('label', {}, label), inp), onClose: () => { if (!done) res(null); }, buttons: [{ label: 'Cancel' }, { label: 'OK', cls: 'primary', onClick: () => { done = true; res(inp.value); } }] });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') { done = true; res(inp.value); m.close(); } });
  });
}

let toastTimer = null;
export function toast(msg, ms = 2600) {
  let t = document.querySelector('.toast');
  if (!t) { t = h('div', { class: 'toast' }); document.body.append(t); }
  t.textContent = msg; t.style.display = 'block';
  clearTimeout(toastTimer); toastTimer = setTimeout(() => { t.style.display = 'none'; }, ms);
}

export function contextMenu(x, y, items) {
  const m = document.getElementById('ctxmenu');
  m.innerHTML = '';
  for (const it of items) {
    if (it === '-') { m.append(h('hr')); continue; }
    if (!it) continue;
    m.append(h('button', { onclick: () => { hide(); it.action(); } }, it.label, it.key ? h('kbd', {}, it.key) : null));
  }
  m.classList.remove('hidden');
  const r = m.getBoundingClientRect();
  m.style.left = Math.min(x, innerWidth - r.width - 6) + 'px'; m.style.top = Math.min(y, innerHeight - r.height - 6) + 'px';
  const hide = () => { m.classList.add('hidden'); document.removeEventListener('mousedown', out, true); };
  const out = (e) => { if (!m.contains(e.target)) hide(); };
  setTimeout(() => document.addEventListener('mousedown', out, true), 0);
}

export function overlay(text) {
  const o = document.getElementById('overlay');
  if (text == null) { o.classList.add('hidden'); return; }
  o.classList.remove('hidden'); document.getElementById('overlay-text').textContent = text;
}
