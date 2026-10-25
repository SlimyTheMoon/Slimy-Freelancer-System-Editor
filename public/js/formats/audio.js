// Freelancer audio: [Sound] tables (freelancer.ini [Data] sounds = …), voice profiles (voices = …) and the
// voice banks (DATA/AUDIO/<voice>.utf: one leaf per line, named by CreateID(msg), holding a WAV).
// Almost every game WAV wraps MP3 frames (format tag 0x55); the browser decodes the frames directly.
import { api, dataPath } from '../api.js';
import { loadIni } from '../gamedata.js';
import { parseUtf } from './utf.js';
import { createID } from './crc.js';

const lc = (s) => String(s || '').toLowerCase();

// RIFF/WAVE → { tag, channels, rate, bits, data: Uint8Array }
export function parseWav(u8) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  if (u8.length < 12 || dv.getUint32(0, false) !== 0x52494646 || dv.getUint32(8, false) !== 0x57415645) return null;
  let p = 12, fmt = null, data = null;
  while (p + 8 <= u8.length) {
    const id = String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]), size = dv.getUint32(p + 4, true);
    if (id === 'fmt ') fmt = { tag: dv.getUint16(p + 8, true), channels: dv.getUint16(p + 10, true), rate: dv.getUint32(p + 12, true), bits: dv.getUint16(p + 22, true) };
    else if (id === 'data') data = u8.subarray(p + 8, Math.min(u8.length, p + 8 + size));
    p += 8 + size + (size & 1);
  }
  return fmt && data ? { ...fmt, data } : null;
}
let ctx = null;
export function audioContext() { if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)(); if (ctx.state === 'suspended') ctx.resume(); return ctx; }
export async function decodeFlWav(u8) {
  const w = parseWav(u8);
  const c = audioContext();
  const bytes = w && w.tag === 0x55 ? w.data : u8; // MP3 frames, or the whole PCM WAV
  return c.decodeAudioData(bytes.slice().buffer);
}
export function mp3Of(u8) { const w = parseWav(u8); return w && w.tag === 0x55 ? w.data : null; }

let current = null;
export function stopAudio() { if (current) { try { current.src.stop(); } catch { } current = null; } }
export async function playBuffer(buf, { gain = 1, onEnd } = {}) {
  stopAudio();
  const c = audioContext(), src = c.createBufferSource(), g = c.createGain();
  g.gain.value = gain; src.buffer = buf; src.connect(g).connect(c.destination);
  src.onended = () => { if (current && current.src === src) current = null; onEnd && onEnd(); };
  src.start(); current = { src, start: c.currentTime, buf };
  return current;
}
// a separate, overlapping player (cutscenes play several sounds at once)
export async function playOverlay(buf, gain = 1) {
  const c = audioContext(), src = c.createBufferSource(), g = c.createGain();
  g.gain.value = gain; src.buffer = buf; src.connect(g).connect(c.destination); src.start();
  return src;
}
export const playing = () => current;
export const dbToGain = (db) => Math.pow(10, (+db || 0) / 20);

// ---------- index ----------
export async function audioIndex(app) {
  if (app._audioIndex) return app._audioIndex;
  const busy = (fn) => app.whileBusy ? app.whileBusy(fn) : fn();
  app._audioIndex = busy(async () => {
    const dsec = app.game.flIni && app.game.flIni.first('Data');
    const list = (k, def) => { const v = dsec ? dsec.getAll(k) : []; return v.length ? v : def; };
    const sounds = new Map(), voices = new Map();
    const sFiles = list('sounds', ['audio\\sounds.ini']), sDocs = await Promise.all(sFiles.map(f => loadIni(dataPath(f)))); // parallel reads
    for (let si = 0; si < sFiles.length; si++) {
      const f = sFiles[si], d = sDocs[si]; if (!d) continue;
      for (const s of d.all('Sound')) {
        const n = s.get('nickname'); if (!n) continue;
        sounds.set(lc(n), { nickname: n, file: s.get('file'), attenuation: s.get('attenuation'), range: s.get('range'), pitch: s.get('crv_pitch'), is2d: s.get('is_2d'), streamer: s.get('streamer'), ini: f, section: s });
      }
    }
    const vFiles = list('voices', []), vDocs = await Promise.all(vFiles.map(f => loadIni(dataPath(f))));
    for (let vi = 0; vi < vFiles.length; vi++) {
      const f = vFiles[vi], d = vDocs[vi]; if (!d) continue;
      let cur = null;
      for (const s of d.sections) {
        if (s.is('Voice')) {
          const n = s.get('nickname') || s.get('extend'); if (!n) { cur = null; continue; }
          cur = voices.get(lc(n)) || { nickname: n, msgs: [], inis: [] }; voices.set(lc(n), cur); if (!cur.inis.includes(f)) cur.inis.push(f);
        } else if (s.is('Sound') && cur) {
          const m = s.get('msg'); if (m) cur.msgs.push({ msg: m, duration: parseFloat(s.get('duration') || '0') || null, attenuation: s.get('attenuation'), ini: f });
        }
      }
    }
    // msg → voices that speak it
    const byMsg = new Map();
    for (const v of voices.values()) for (const m of v.msgs) { const k = lc(m.msg); if (!byMsg.has(k)) byMsg.set(k, []); byMsg.get(k).push(v.nickname); }
    return { sounds, voices, byMsg };
  });
  app._audioIndex.catch(() => { app._audioIndex = null; }); // a failed read must not stick for the session
  return app._audioIndex;
}
const bankCache = new Map();
export async function voiceBank(voice) {
  const k = lc(voice);
  if (!bankCache.has(k)) bankCache.set(k, (async () => {
    const b = await api.read(dataPath('audio\\' + voice + '.utf')); if (!b) return null;
    try { const root = parseUtf(b); const map = new Map(); for (const c of root.children) { const leaf = c.isLeaf ? c : (c.children || []).find(x => x.isLeaf); if (leaf && leaf.data) map.set(lc(c.name), leaf.data); } return map; } catch { return null; }
  })());
  return bankCache.get(k);
}
export const lineKey = (msg) => '0x' + (createID(msg) >>> 0).toString(16).toLowerCase();
export async function voiceLine(voice, msg) { const bank = await voiceBank(voice); return bank ? bank.get(lineKey(msg)) || null : null; }

// nickname of a [Sound] or a voice line (msg) → bytes
export async function soundBytes(app, name, { voice = null } = {}) {
  const idx = await audioIndex(app);
  const s = idx.sounds.get(lc(name));
  if (s && s.file) return { bytes: await api.read(dataPath(s.file)), kind: 'sound', info: s };
  const voices = voice ? [voice, ...(idx.byMsg.get(lc(name)) || [])] : (idx.byMsg.get(lc(name)) || []);
  for (const v of voices) { const b = await voiceLine(v, name); if (b) return { bytes: b, kind: 'voice', voice: v }; }
  return null;
}
