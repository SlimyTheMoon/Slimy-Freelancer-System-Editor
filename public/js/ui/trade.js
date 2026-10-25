// Trade planner window: Routes · Commodities · Markets (with market line editing).
import { h, datalist, modal, toast, overlay } from './dom.js';
import { TradeData, TRADE_DEFAULTS, fmtTime, fmtCr } from '../trade.js';
import { IniEntry } from '../formats/ini.js';

const OPT_KEY = 'fled.trade';
function loadOpt() { try { return { ...TRADE_DEFAULTS, ...JSON.parse(localStorage.getItem(OPT_KEY) || '{}') }; } catch { return { ...TRADE_DEFAULTS }; } }
function saveOpt(o) { try { localStorage.setItem(OPT_KEY, JSON.stringify(o)); } catch { } }

export async function tradePlanner(app, initial = {}) {
  if (!app.trade) app.trade = new TradeData(app);
  const T = app.trade;
  if (!T.nodes) {
    overlay('Preparing trade data…');
    try { await T.load((msg) => overlay(msg + '…')); }
    finally { overlay(null); }
  }
  if (T.graphDirty) { T.buildGraph(); T.cache = null; T.graphDirty = false; }
  const g = app.game;
  const opt = loadOpt();
  const baseLabel = (b) => { const bb = g.findBase(b); return `${(bb && g.name(bb.strid)) || b}`; };
  const sysLabel = (s) => { const sy = g.findSystem(s); return (sy && g.name(sy.strid)) || s; };
  const tabs = h('div', { class: 'tabs', style: { display: 'flex', gap: '4px', marginBottom: '10px' } });
  const body = h('div');
  const root = h('div', {}, tabs, body);
  const m = modal({ title: 'Trade planner', body: root, wide: true, onClose: () => { if (T.onChange === refresh) T.onChange = null; } });
  const refresh = () => { if (current === 'markets' || current === 'goods') { lastRoutes = null; show(current); } else lastRoutes = null; };
  T.onChange = refresh;
  m.box.classList.add('xwide');
  let current = initial.tab || 'routes';
  const show = (t, arg) => { current = t; for (const b of tabs.children) b.classList.toggle('on', b.dataset.t === t); body.innerHTML = ''; ({ routes: routesTab, goods: goodsTab, markets: marketsTab })[t](arg); };
  for (const [t, l] of [['routes', 'Routes'], ['goods', 'Commodities'], ['markets', 'Markets']]) tabs.append(h('button', { class: 'chip', 'data-t': t, onclick: () => show(t) }, l));

  const sysOptions = (sel) => [h('option', { value: '' }, 'any system'), ...g.systems.slice().sort((a, b) => sysLabel(a.nickname).localeCompare(sysLabel(b.nickname))).map(s => h('option', { value: s.nickname.toLowerCase(), selected: sel === s.nickname.toLowerCase() }, `${sysLabel(s.nickname)} (${s.nickname})`))];
  const commodityList = () => [...new Set([...T.market.values()].flat().filter(x => x.commodity && !x.unknown).map(x => x.good.toLowerCase()))].map(k => ({ k, name: T.goodName(k) })).sort((a, b) => a.name.localeCompare(b.name));

  // ------------------------------------------------------------ routes
  let lastRoutes = null, routeFilter = { fromSystem: initial.fromSystem || '', toSystem: '', good: '' }, sortKey = 'perMin';
  function routesTab() {
    const num = (k, label, step, title) => h('label', { class: 'topt', title: title || '' }, label, h('input', { type: 'number', value: opt[k], step, style: { width: '72px' }, onchange: (e) => { opt[k] = parseFloat(e.target.value) || 0; saveOpt(opt); T.cache = null; } }));
    const chk = (k, label, title) => h('label', { class: 'topt', title: title || '' }, h('input', { type: 'checkbox', checked: !!opt[k], onchange: (e) => { opt[k] = e.target.checked; saveOpt(opt); T.cache = null; } }), label);
    const from = h('select', { onchange: () => routeFilter.fromSystem = from.value }, sysOptions(routeFilter.fromSystem));
    const to = h('select', { onchange: () => routeFilter.toSystem = to.value }, sysOptions(routeFilter.toSystem));
    const good = h('select', { onchange: () => routeFilter.good = good.value }, h('option', { value: '' }, 'any commodity'), commodityList().map(c => h('option', { value: c.k, selected: routeFilter.good === c.k }, c.name)));
    const result = h('div', { style: { marginTop: '10px' } });
    const run = async () => {
      result.innerHTML = ''; result.append(h('div', { class: 'empty' }, 'Computing routes…'));
      const t0 = performance.now();
      lastRoutes = await T.routes(opt, routeFilter, (msg) => { result.firstChild.textContent = msg; });
      renderRoutes(result, performance.now() - t0);
    };
    body.append(
      h('div', { class: 'topts' }, num('cargo', 'Cargo hold', 10, 'Cargo units (commodities with volume > 1 fit fewer)'), num('cruise', 'Cruise m/s', 10), num('lane', 'Lane m/s', 100), num('jumpTime', 'Jump s', 1, 'Seconds per jump incl. tunnel'), num('dockTime', 'Dock s', 1, 'Seconds to dock/undock at each end'), num('laneEnter', 'Lane entry s', 1),
        chk('holes', 'Use jump holes'), chk('unlisted', 'Sell at unlisted bases', 'Freelancer lets you sell any commodity at any base; unlisted bases pay the goods.ini base price')),
      h('div', { class: 'topts' }, h('label', { class: 'topt' }, 'From', from), h('label', { class: 'topt' }, 'To', to), h('label', { class: 'topt' }, 'Commodity', good),
        h('button', { class: 'btn primary', onclick: run }, 'Find routes')),
      result);
    if (lastRoutes) renderRoutes(result); else run();
  }
  function renderRoutes(el, ms) {
    el.innerHTML = '';
    const rows = lastRoutes.slice().sort((a, b) => sortKey === 'time' ? a.time - b.time : b[sortKey] - a[sortKey]).slice(0, 300);
    const th = (k, l) => h('th', { class: 'sortable' + (sortKey === k ? ' on' : ''), onclick: () => { sortKey = k; renderRoutes(el); } }, l);
    const detail = h('div', { class: 'routedetail' });
    const tbl = h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', {}, 'Commodity'), h('th', {}, 'Buy at'), h('th', { class: 'r' }, 'Price'), h('th', {}, 'Sell at'), h('th', { class: 'r' }, 'Price'), th('perUnit', 'Profit/u'), th('perRun', 'Profit/run'), th('time', 'Time'), th('perMin', 'Profit/min'))),
      h('tbody', {}, rows.map(r => h('tr', { onclick: (e) => { tbl.querySelectorAll('tr.sel').forEach(x => x.classList.remove('sel')); e.currentTarget.classList.add('sel'); routeDetail(detail, r); } },
        h('td', {}, T.goodName(r.good)),
        h('td', {}, baseLabel(r.seller.base), h('span', { class: 'sub' }, sysLabel(T.baseSystem(r.seller.base)))),
        h('td', { class: 'r' }, fmtCr(r.seller.price)),
        h('td', {}, baseLabel(r.buyer.base), h('span', { class: 'sub' }, sysLabel(T.baseSystem(r.buyer.base)) + (r.buyer.unlisted ? ' · unlisted' : ''))),
        h('td', { class: 'r' }, fmtCr(r.buyer.price)),
        h('td', { class: 'r' }, fmtCr(r.perUnit)), h('td', { class: 'r' }, fmtCr(r.perRun)), h('td', { class: 'r' }, fmtTime(r.time)), h('td', { class: 'r b' }, fmtCr(r.perMin))))));
    el.append(h('div', { class: 'note', style: { marginBottom: '6px' } }, `${(lastRoutes.total ?? lastRoutes.length).toLocaleString()} profitable runs${ms ? ` · ${Math.round(ms)} ms` : ''} · showing top ${rows.length}. Click a row for the path.`), h('div', { class: 'tradeflex' }, h('div', { class: 'tblwrap' }, tbl), detail));
  }
  function routeDetail(el, r) {
    const res = T.times(r.seller.base.toLowerCase(), opt), p = T.path(res, r.buyer.base.toLowerCase());
    el.innerHTML = '';
    if (!p) { el.append('No path.'); return; }
    const sysChain = p.systems.map(s => sysLabel(s)).join(' → ');
    el.append(h('div', {}, h('h3', {}, T.goodName(r.good)),
      h('div', { class: 'stat' }, 'Buy', h('b', {}, `${fmtCr(r.seller.price)} at ${baseLabel(r.seller.base)}`), 'Sell', h('b', {}, `${fmtCr(r.buyer.price)} at ${baseLabel(r.buyer.base)}`),
        'Units', h('b', {}, `${r.units} (volume ${T.volume(r.good)})`), 'Profit/run', h('b', {}, fmtCr(r.perRun)),
        'Travel', h('b', {}, `${fmtTime(p.time)} + ${opt.dockTime * 2}s docking`), 'Jumps', h('b', {}, String(p.jumps)),
        'Trade lane', h('b', {}, `${(p.laneDist / 1000).toFixed(0)} km`), 'Cruise', h('b', {}, `${(p.flyDist / 1000).toFixed(0)} km`)),
      h('div', { style: { margin: '8px 0', fontSize: '12px' } }, sysChain),
      r.seller.level || r.seller.rep > -1 ? h('div', { class: 'sev-warn', style: { fontSize: '12px' } }, `Seller requires level ${r.seller.level}${r.seller.rep > -1 ? `, reputation ≥ ${r.seller.rep}` : ''}`) : null,
      h('div', { class: 'btnrow', style: { marginTop: '8px' } },
        h('button', { class: 'btn sm', onclick: () => show('markets', r.seller.base) }, 'Seller market'),
        h('button', { class: 'btn sm', onclick: () => show('markets', r.buyer.base) }, 'Buyer market'),
        h('button', { class: 'btn sm', onclick: () => gotoBase(r.seller.base) }, 'Show seller'),
        h('button', { class: 'btn sm', onclick: () => gotoBase(r.buyer.base) }, 'Show buyer'))));
  }
  async function gotoBase(base) {
    const n = T.nodes[T.baseNode.get(base.toLowerCase())]; if (!n) return;
    m.close();
    await app.openSystem(n.sys);
    const sec = app.sys.byNick(n.nick); if (sec) { app.select(sec.id); app.viewport.focus(sec.id); }
  }

  // ------------------------------------------------------------ commodities
  let goodSel = initial.good || '';
  function goodsTab() {
    const list = commodityList(); if (!goodSel && list[0]) goodSel = list[0].k;
    const sel = h('select', { onchange: () => { goodSel = sel.value; draw(); } }, list.map(c => h('option', { value: c.k, selected: c.k === goodSel }, c.name)));
    const out = h('div', { style: { marginTop: '8px' } });
    const draw = () => {
      out.innerHTML = '';
      const gd = T.goods.get(goodSel); if (!gd) return;
      const rows = [...T.market.values()].flat().filter(x => x.good.toLowerCase() === goodSel);
      const sells = rows.filter(x => x.sells).sort((a, b) => a.price - b.price), buys = rows.filter(x => !x.sells).sort((a, b) => b.price - a.price);
      const tbl = (title, list) => h('div', { style: { flex: 1, minWidth: '0' } }, h('h3', {}, title),
        h('table', { class: 'grid' }, h('thead', {}, h('tr', {}, h('th', {}, 'Base'), h('th', {}, 'System'), h('th', { class: 'r' }, '×'), h('th', { class: 'r' }, 'Price'))),
          h('tbody', {}, list.map(x => h('tr', { onclick: () => show('markets', x.base) }, h('td', {}, baseLabel(x.base)), h('td', {}, sysLabel(T.baseSystem(x.base))), h('td', { class: 'r' }, String(x.mult)), h('td', { class: 'r b' }, fmtCr(x.price)))))));
      out.append(h('div', { class: 'note' }, `Base price ${fmtCr(gd.price)} · volume ${T.volume(goodSel)} · ${sells.length} sellers, ${buys.length} buyers (only listed bases).`),
        h('div', { style: { display: 'flex', gap: '16px', marginTop: '6px' } }, tbl(`Sold at (cheapest first)`, sells), tbl(`Bought at (best first)`, buys)),
        h('div', { class: 'btnrow', style: { marginTop: '8px' } }, h('button', { class: 'btn sm', onclick: () => { routeFilter.good = goodSel; lastRoutes = null; show('routes'); } }, 'Routes for this commodity')));
    };
    body.append(h('label', { class: 'topt' }, 'Commodity', sel), out); draw();
  }

  // ------------------------------------------------------------ markets
  let baseSel = initial.base || '', openEquip = false;
  function marketsTab(arg) {
    if (arg) baseSel = arg;
    const bases = g.bases.slice().sort((a, b) => baseLabel(a.nickname).localeCompare(baseLabel(b.nickname)));
    if (!baseSel && bases[0]) baseSel = bases[0].nickname;
    const dl = datalist(bases.map(b => ({ value: b.nickname, label: `${baseLabel(b.nickname)} · ${sysLabel(b.system)}` })));
    const pick = h('input', { value: baseSel, style: { width: '260px' }, onchange: () => { baseSel = pick.value.trim(); draw(); } }); pick.setAttribute('list', dl.id);
    const out = h('div', { style: { marginTop: '8px' } });
    const goodsDl = datalist([...T.goods.values()].filter(gd => gd.category !== 'shiphull').map(gd => ({ value: gd.nickname, label: `${T.goodName(gd.nickname)} · ${T.goodKind(gd.nickname)}` })));
    const edit = (label, mm, fn) => { app.history.do(label, [mm.doc], fn); T.readMarkets(); T.cache = null; lastRoutes = null; draw(); };
    const draw = () => {
      out.innerHTML = '';
      const b = g.findBase(baseSel); if (!b) { out.append(h('div', { class: 'sev-err' }, 'Unknown base')); return; }
      const list = T.baseMarket(b.nickname);
      const comm = list.filter(x => x.commodity), other = list.filter(x => !x.commodity);
      out.append(h('div', { class: 'note' }, `${baseLabel(b.nickname)} · ${sysLabel(b.system)} · ${comm.length} commodity lines, ${other.length} equipment/ship lines${(comm[0] || list[0]) ? ` · ${(comm[0] || list[0]).doc.path.split('/').pop()}` : ''}`));
      const row = (x) => {
        const mult = h('input', { type: 'number', value: x.mult, step: 0.05, style: { width: '70px' }, onchange: (e) => edit('Market multiplier', x, () => TradeData.setFields(x, { mult: e.target.value })) });
        const sells = h('select', { onchange: (e) => edit('Market sells/buys', x, () => TradeData.setFields(x, e.target.value === 's' ? { min: x.min || (x.commodity ? 150 : 10), max: x.max || (x.commodity ? 500 : 10), flag: 0 } : { min: 0, max: 0, flag: 1 })) }, h('option', { value: 's', selected: x.sells }, 'sells'), h('option', { value: 'b', selected: !x.sells }, 'buys only'));
        const lvl = h('input', { type: 'number', value: x.level, style: { width: '48px' }, onchange: (e) => edit('Market level', x, () => TradeData.setFields(x, { level: e.target.value })) });
        const rep = h('input', { type: 'number', value: x.rep, step: 0.1, style: { width: '56px' }, onchange: (e) => edit('Market reputation', x, () => TradeData.setFields(x, { rep: e.target.value })) });
        return h('tr', {}, h('td', {}, T.goodName(x.good), h('span', { class: 'sub' }, x.good), x.unknown ? h('span', { class: 'sev-err' }, ' unknown good') : null),
          h('td', {}, sells), h('td', { class: 'r' }, mult), h('td', { class: 'r b' }, fmtCr(x.price)), h('td', {}, lvl), h('td', {}, rep),
          h('td', {}, h('button', { class: 'btn sm', onclick: () => edit('Remove market good', x, () => x.sec.removeEntry(x.entry)) }, '×')));
      };
      out.append(h('table', { class: 'grid mkt' }, h('colgroup', {}, ['auto', '130px', '90px', '80px', '70px', '80px', '36px'].map(w => h('col', { style: { width: w } }))), h('thead', {}, h('tr', {}, h('th', {}, 'Commodity'), h('th', {}, 'Trade'), h('th', { class: 'r' }, '× price'), h('th', { class: 'r' }, 'Price'), h('th', {}, 'Level'), h('th', {}, 'Rep'), h('th'))), h('tbody', {}, comm.map(row))));
      const addIn = h('input', { placeholder: 'good: commodity, equipment or ship package…', style: { width: '320px' } }); addIn.setAttribute('list', goodsDl.id);
      out.append(h('div', { class: 'btnrow', style: { marginTop: '8px' } }, addIn, h('button', { class: 'btn sm', onclick: () => {
        const good = addIn.value.trim(); if (!T.goods.has(good.toLowerCase())) { toast('Unknown good'); return; }
        const same = list.filter(x => x.commodity === T.isCommodity(good)); let sec = (same[0] || list[0]) && (same[0] || list[0]).sec, doc = (same[0] || list[0]) && (same[0] || list[0]).doc;
        if (!sec) { doc = T.marketDocs.find(d => /commodit/i.test(d.path)) || T.marketDocs[0]; if (!doc) { toast('No market file'); return; } }
        app.history.do('Add market good', [doc], () => {
          if (!sec) sec = doc.ini.addSection('BaseGood', null, [['base', b.nickname]]);
          sec.lines.splice(sec.lastEntryIndex() + 1, 0, new IniEntry('MarketGood', T.isCommodity(good) ? `${good}, 0, -1, 150, 500, 0, 1` : `${good}, 0, -1, 10, 10, 0, 1`));
        });
        T.readMarkets(); T.cache = null; lastRoutes = null; draw();
      } }, '+ Add (sells)')));
      if (other.length) {
        // equipment & ships: same editor as commodities, grouped by kind, with in-game names
        const kinds = [...new Set(other.map(x => T.goodKind(x.good) || 'other'))].sort((a, b) => (a === 'Ship') - (b === 'Ship') || a.localeCompare(b));
        const det = h('details', { open: !!openEquip, style: { marginTop: '12px' }, ontoggle: (e) => { openEquip = e.target.open; } }, h('summary', { style: { cursor: 'pointer', fontSize: '12px', color: 'var(--dim)' } }, `Equipment & ships (${other.length})`));
        for (const k of kinds) {
          const rows = other.filter(x => (T.goodKind(x.good) || 'other') === k).sort((a, b) => T.goodName(a.good).localeCompare(T.goodName(b.good)));
          det.append(h('div', { style: { fontSize: '11px', color: 'var(--faint)', margin: '8px 0 2px' } }, `${k} (${rows.length})`),
            h('table', { class: 'grid mkt' }, h('colgroup', {}, ['auto', '130px', '90px', '80px', '70px', '80px', '36px'].map(w => h('col', { style: { width: w } }))), h('thead', {}, h('tr', {}, h('th', {}, 'Item'), h('th', {}, 'Trade'), h('th', { class: 'r' }, '× price'), h('th', { class: 'r' }, 'Price'), h('th', {}, 'Level'), h('th', {}, 'Rep'), h('th'))), h('tbody', {}, rows.map(row))));
        }
        out.append(det);
      }
    };
    body.append(h('label', { class: 'topt' }, 'Base', pick, dl.el, goodsDl.el), out); draw();
  }

  show(current, initial.base);
}
