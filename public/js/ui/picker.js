// Generic search picker (one dialog for every kind: loadouts, factions, bases,
// MusicSelection, StarSelection, ParentSelectPopup, …). One dialog here, fed with rich item lists.
import { h, modal } from './dom.js';
import { dataPath } from '../api.js';
import { loadIni } from '../gamedata.js';

// items: [{ value, label?, sub? }] · preview(item) -> Element | null
export function searchPicker(app, { title, items, current = '', preview = null }) {
  return new Promise((resolve) => {
    let chosen = null, done = false;
    const q = h('input', { placeholder: `Search ${items.length.toLocaleString()} entries…`, style: { width: '100%', marginBottom: '6px' } });
    const list = h('div', { class: 'reflist', style: { height: '52vh', overflow: 'auto' } });
    const pv = h('div', { style: { fontSize: '12px', overflow: 'auto', maxHeight: '52vh' } });
    let shown = [], sel = -1;
    const pick = (i) => { sel = i; chosen = shown[i]; list.querySelectorAll('.sel').forEach(x => x.classList.remove('sel')); const el = list.children[i]; if (el) { el.classList.add('sel'); el.scrollIntoView({ block: 'nearest' }); } pv.innerHTML = ''; if (preview && chosen) { const p = preview(chosen); if (p) pv.append(p); } };
    const render = () => {
      const t = q.value.trim().toLowerCase().split(/\s+/).filter(Boolean);
      shown = items.filter(it => { const hay = `${it.value} ${it.label || ''} ${it.sub || ''}`.toLowerCase(); return t.every(w => hay.includes(w)); }).slice(0, 2000);
      list.innerHTML = '';
      shown.forEach((it, i) => list.append(h('div', { style: { padding: '3px 8px', cursor: 'pointer' }, onclick: () => pick(i), ondblclick: () => { done = true; resolve(it.value); m.close(); } },
        h('span', {}, it.label || it.value), it.label ? h('span', { style: { color: 'var(--faint)', marginLeft: '8px', fontFamily: 'var(--mono)', fontSize: '11px' } }, it.value) : null,
        it.sub ? h('span', { style: { color: 'var(--faint)', float: 'right', fontSize: '11px' } }, it.sub) : null)));
      const ci = shown.findIndex(it => it.value.toLowerCase() === (current || '').toLowerCase());
      if (ci >= 0) pick(ci); else if (shown.length) pick(0);
    };
    q.oninput = render;
    q.onkeydown = (e) => {
      if (e.key === 'ArrowDown') { e.preventDefault(); pick(Math.min(shown.length - 1, sel + 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); pick(Math.max(0, sel - 1)); }
      else if (e.key === 'Enter' && chosen) { e.preventDefault(); done = true; resolve(chosen.value); m.close(); }
    };
    const m = modal({
      title, wide: !!preview,
      body: h('div', { style: { display: 'grid', gridTemplateColumns: preview ? '1.3fr 1fr' : '1fr', gap: '12px' } }, h('div', {}, q, list), preview ? pv : null),
      onClose: () => { if (!done) resolve(null); },
      buttons: [{ label: 'Cancel' }, { label: 'Use', cls: 'primary', onClick: () => { if (!chosen) return false; done = true; resolve(chosen.value); } }],
    });
    render();
  });
}

// ---------------------------------------------------------------- item sources
let pilots = null;
async function pilotList() {
  if (!pilots) { pilots = []; for (const f of ['missions\\pilots_population.ini', 'missions\\pilots_story.ini']) { const d = await loadIni(dataPath(f)); if (d) for (const s of d.all('Pilot')) { const n = s.get('nickname'); if (n) pilots.push(n); } } }
  return pilots;
}
const MUSIC_KEYS = new Set(['music', 'space', 'danger', 'battle']);
export const PICKER_KEYS = new Set(['loadout', 'reputation', 'affiliation', 'local_faction', 'base', 'dock_with', 'star', 'music', 'space', 'danger', 'battle', 'pilot', 'voice', 'parent', 'prev_ring', 'next_ring', 'spacedust', 'jump_effect', 'faction']);

export async function pickerFor(app, key, sec, observed) {
  const g = app.game, sys = app.sys, k = key.toLowerCase();
  const facs = () => g.factions.map(f => ({ value: f.nickname, label: g.name(f.ids) || '' }));
  switch (true) {
    case k === 'loadout': {
      const eqName = (n) => g.name(g.equipIds.get(n.toLowerCase())) || '';
      return {
        title: 'Loadout', items: g.loadouts.map(n => ({ value: n, sub: `${(g.loadoutEquip.get(n.toLowerCase()) || []).length} items` })),
        preview: (it) => { const eq = g.loadoutEquip.get(it.value.toLowerCase()) || []; return h('div', {}, h('h3', {}, it.value), eq.length ? h('table', { class: 'grid' }, h('tbody', {}, eq.map(([e, hp]) => h('tr', {}, h('td', {}, e, eqName(e) ? h('span', { class: 'sub' }, eqName(e)) : null), h('td', {}, hp || ''))))) : h('div', { class: 'empty' }, 'empty loadout')); },
      };
    }
    case k === 'reputation' || k === 'affiliation' || k === 'local_faction' || k === 'faction': return { title: 'Faction', items: facs() };
    case k === 'base' || k === 'dock_with': return { title: 'Base', items: g.bases.map(b => ({ value: b.nickname, label: g.name(b.strid) || '', sub: b.system })) };
    case k === 'star': { const { starPreview } = await import('./starpreview.js'); return { title: 'Star', items: [...g.stars.values()].map(s => ({ value: s.nickname, sub: `radius ${s.radius}` })), preview: (it) => h('div', {}, starPreview(g, it.value, 260)) }; }
    case MUSIC_KEYS.has(k): return { title: 'Music', items: g.music.map(m => ({ value: m })) };
    case k === 'pilot': { const set = new Set([...(await pilotList()), ...(observed || [])]); return { title: 'Pilot', items: [...set].sort().map(v => ({ value: v })) }; }
    case k === 'parent' || k === 'prev_ring' || k === 'next_ring':
      return { title: k, items: sys.objects.filter(o => o !== sec).map(o => ({ value: o.get('nickname'), label: g.name(o.get('ids_name')) || '', sub: o.get('archetype') })) };
    case k === 'spacedust': return { title: 'Space dust', items: g.spacedust.map(v => ({ value: v })) };
    case k === 'jump_effect': return { title: 'Jump effect', items: g.jumpEffects.map(v => ({ value: v })) };
    default: return { title: key, items: (observed || []).map(v => ({ value: typeof v === 'string' ? v : v.value })) };
  }
}
