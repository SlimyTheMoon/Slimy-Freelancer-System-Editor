// Sound & voice browser (Assets menu): [Sound] tables, voice profiles with their lines, and every WAV under
// DATA\AUDIO. Plays the game's MP3-in-WAV files, shows the waveform, exports .mp3 / .wav, and finds which voice
// bank holds a line (lines are stored under CreateID(msg)).
import { h, modal, toast, overlay } from './dom.js';
import { api, dataPath } from '../api.js';
import { audioIndex, voiceBank, lineKey, decodeFlWav, playBuffer, stopAudio, parseWav, mp3Of, dbToGain } from '../formats/audio.js';

const lc = (s) => String(s || '').toLowerCase();
const dur = (s) => s == null ? '' : s < 60 ? s.toFixed(2) + ' s' : `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

export async function audioBrowser(app, { find = '' } = {}) {
  overlay('Reading sounds and voices…');
  let idx; try { idx = await audioIndex(app); } finally { overlay(null); }
  let tab = 'sounds';
  const tabs = h('div', { class: 'btnrow' });
  const filter = h('input', { placeholder: 'Filter…', value: find, style: { flex: '1' } });
  const list = h('div', { style: { height: 'calc(100vh - 420px)', overflow: 'auto', fontSize: '12px' } });
  const wave = h('canvas', { height: 90, style: { width: '100%', height: '90px', display: 'block', background: 'var(--well)', borderRadius: '6px' } });
  const info = h('div', { style: { fontSize: '12px', margin: '6px 0', minHeight: '34px' } }, 'Click ▶ to play.');
  const dl = h('div', { class: 'btnrow' });
  let files = null, sel = null;

  function drawWave(buf, t = null) {
    const g = wave.getContext('2d'); wave.width = wave.getBoundingClientRect().width || 600; const W = wave.width, H = wave.height;
    g.clearRect(0, 0, W, H); if (!buf) return;
    const d = buf.getChannelData(0), step = Math.max(1, Math.floor(d.length / W));
    g.strokeStyle = '#5fb3ff'; g.beginPath();
    for (let x = 0; x < W; x++) { let mn = 1, mx = -1; for (let i = x * step; i < Math.min(d.length, (x + 1) * step); i++) { const v = d[i]; if (v < mn) mn = v; if (v > mx) mx = v; } g.moveTo(x, (1 - mx) * H / 2); g.lineTo(x, (1 - mn) * H / 2); }
    g.stroke();
    if (t != null) { g.fillStyle = '#fff'; g.fillRect((t / buf.duration) * W, 0, 2, H); }
  }
  let raf = null;
  async function play(bytes, label, gainDb = 0, name = 'sound') {
    if (!bytes) { toast('Audio not found'); return; }
    try {
      const buf = await decodeFlWav(bytes);
      const w = parseWav(bytes);
      info.innerHTML = '';
      info.append(h('b', {}, label), h('div', { style: { color: 'var(--faint)' } }, `${dur(buf.duration)} · ${buf.sampleRate} Hz · ${buf.numberOfChannels} ch · ${w ? (w.tag === 0x55 ? 'MP3 in WAV' : w.tag === 1 ? `PCM ${w.bits}-bit` : 'format ' + w.tag) : 'raw'} · ${(bytes.length / 1024).toFixed(0)} KB${gainDb ? ` · attenuation ${gainDb} dB` : ''}`));
      const cur = await playBuffer(buf, { gain: dbToGain(gainDb) });
      cancelAnimationFrame(raf);
      const tick = () => { const c = cur.src.context; const t = c.currentTime - cur.start; drawWave(buf, Math.min(t, buf.duration)); if (t < buf.duration) raf = requestAnimationFrame(tick); };
      tick();
      dl.innerHTML = '';
      const mp3 = mp3Of(bytes);
      const save = (data, ext, type) => { const a = h('a', { href: URL.createObjectURL(new Blob([data], { type })), download: name + ext }); document.body.append(a); a.click(); a.remove(); };
      dl.append(h('button', { class: 'btn sm', onclick: () => stopAudio() }, '■ Stop'), h('button', { class: 'btn sm', onclick: () => save(bytes, '.wav', 'audio/wav') }, 'Save .wav'), mp3 ? h('button', { class: 'btn sm', onclick: () => save(mp3, '.mp3', 'audio/mpeg') }, 'Save .mp3') : null);
    } catch (e) { console.error(e); toast('Could not decode: ' + e.message); }
  }
  const pbtn = (fn) => h('button', { class: 'btn sm', style: { padding: '0 6px' }, onclick: (e) => { e.stopPropagation(); fn(); } }, '▶');
  const row = (cells, onclick) => h('div', { style: { display: 'grid', gridTemplateColumns: '26px 1.3fr 2fr auto', gap: '6px', alignItems: 'center', padding: '2px 4px', borderBottom: '1px solid var(--line, #222)', cursor: onclick ? 'pointer' : 'default' }, onclick }, ...cells);

  async function render() {
    tabs.innerHTML = '';
    for (const [k, l] of [['sounds', `Sounds (${idx.sounds.size})`], ['voices', `Voices (${idx.voices.size})`], ['files', 'All WAV files'], ['line', 'Find a voice line']]) tabs.append(h('button', { class: 'btn sm' + (tab === k ? ' primary' : ''), onclick: () => { tab = k; sel = null; render(); } }, l));
    const q = lc(filter.value);
    list.innerHTML = '';
    if (tab === 'sounds') {
      let n = 0;
      for (const s of idx.sounds.values()) {
        if (q && !lc(s.nickname + ' ' + s.file).includes(q)) continue;
        if (++n > 1500) break;
        list.append(row([pbtn(async () => play(await api.read(dataPath(s.file)), s.nickname, s.attenuation, s.nickname)), h('b', {}, s.nickname), h('span', { style: { color: 'var(--dim)' } }, s.file || '—'), h('span', { style: { color: 'var(--faint)', fontSize: '11px' } }, [s.attenuation ? `${s.attenuation} dB` : '', s.range ? `range ${s.range}` : '', s.ini.split('\\').pop()].filter(Boolean).join(' · '))]));
      }
      if (!n) list.append(h('div', { class: 'empty' }, 'No sounds match.'));
    } else if (tab === 'voices') {
      if (!sel) {
        for (const v of [...idx.voices.values()].sort((a, b) => a.nickname.localeCompare(b.nickname))) {
          if (q && !lc(v.nickname).includes(q) && !v.msgs.some(m => lc(m.msg).includes(q))) continue;
          list.append(row([h('span'), h('b', {}, v.nickname), h('span', { style: { color: 'var(--dim)' } }, `${v.msgs.length} lines`), h('span', { style: { color: 'var(--faint)', fontSize: '11px' } }, v.inis.map(x => x.split('\\').pop()).join(', '))], () => { sel = v; render(); }));
        }
      } else {
        const bank = await voiceBank(sel.nickname);
        list.append(h('div', { class: 'btnrow', style: { margin: '4px 0' } }, h('button', { class: 'btn sm', onclick: () => { sel = null; render(); } }, '← all voices'), h('b', {}, sel.nickname), h('span', { style: { color: 'var(--faint)' } }, bank ? ` · ${bank.size} recordings in ${sel.nickname}.utf` : ' · voice bank not found')));
        const named = new Set();
        for (const m of sel.msgs) {
          const k = lineKey(m.msg); named.add(k);
          if (q && !lc(m.msg).includes(q)) continue;
          const has = bank && bank.has(k);
          list.append(row([has ? pbtn(() => play(bank.get(k), `${sel.nickname} · ${m.msg}`, m.attenuation, m.msg)) : h('span', { title: 'no recording in the bank' }, '–'), h('span', { style: { color: has ? 'var(--text)' : 'var(--faint)' } }, m.msg), h('span', { style: { color: 'var(--faint)', fontFamily: 'var(--mono)', fontSize: '11px' } }, k), h('span', { style: { color: 'var(--faint)', fontSize: '11px' } }, m.duration ? dur(m.duration) : '')]));
        }
        if (bank) {
          const extra = [...bank.keys()].filter(k => !named.has(k));
          if (extra.length && !q) {
            list.append(h('div', { style: { color: 'var(--faint)', margin: '8px 0 2px' } }, `${extra.length} recordings without a msg line in the voice INIs (named by hash only):`));
            for (const k of extra.slice(0, 500)) list.append(row([pbtn(() => play(bank.get(k), `${sel.nickname} · ${k}`, 0, k)), h('span', { style: { fontFamily: 'var(--mono)' } }, k), h('span'), h('span')]));
          }
        }
      }
    } else if (tab === 'files') {
      if (!files) { list.append(h('div', { class: 'empty' }, 'Listing…')); files = await api.find('DATA/AUDIO', ['.wav']); return render(); }
      let n = 0;
      for (const f of files) { if (q && !lc(f).includes(q)) continue; if (++n > 2000) break; list.append(row([pbtn(async () => play(await api.read(f), f.replace(/^DATA\//i, ''), 0, f.split('/').pop().replace(/\.wav$/i, ''))), h('span', {}, f.split('/').pop()), h('span', { style: { color: 'var(--faint)' } }, f.replace(/^DATA\//i, '').split('/').slice(0, -1).join('/')), h('span')])); }
    } else {
      const v = filter.value.trim();
      list.append(h('div', { style: { color: 'var(--dim)', margin: '4px 0' } }, 'Type a line name (msg), e.g. DX_M01_0700_KING or gcs_refer_system_Li01, into the filter. Its key is CreateID(msg).'));
      if (v.length >= 3) {
        const k = lineKey(v);
        list.append(h('div', { style: { fontFamily: 'var(--mono)', margin: '4px 0' } }, `${v} → ${k}`));
        const known = idx.byMsg.get(lc(v)) || [];
        const banks = await api.find('DATA/AUDIO', ['.utf']);
        let hits = 0;
        for (const b of banks) {
          const name = b.split('/').pop().replace(/\.utf$/i, '');
          const bank = await voiceBank(name); if (!bank || !bank.has(k)) continue;
          hits++; list.append(row([pbtn(() => play(bank.get(k), `${name} · ${v}`, 0, v)), h('b', {}, name), h('span', { style: { color: 'var(--dim)' } }, known.some(x => lc(x) === lc(name)) ? 'listed in the voice INI' : 'not listed in the voice INI'), h('span')]));
        }
        if (!hits) list.append(h('div', { class: 'empty' }, 'No voice bank has this line.'));
      }
    }
  }
  let ft = null; filter.oninput = () => { clearTimeout(ft); ft = setTimeout(render, 200); };
  modal({ title: 'Sounds & voices', wide: true, onClose: () => { stopAudio(); cancelAnimationFrame(raf); },
    body: h('div', {}, tabs, h('div', { class: 'btnrow', style: { margin: '6px 0' } }, filter), list, h('hr'), info, wave, dl),
    buttons: [{ label: 'Close' }] });
  render(); drawWave(null);
}
