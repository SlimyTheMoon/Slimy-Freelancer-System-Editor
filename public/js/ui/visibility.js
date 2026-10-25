// What the 3D view draws — one model, like layers in an image editor:
//   Objects / Zones / Light sources  →  categories (Suns & planets, Stations…, Asteroid fields, Nebulae…)  →  items.
// Every level has an eye. An item is drawn when its kind, its category and the item itself are all switched on
// (and, with "draw only listed", when it is in the Outliner list). Kinds and categories apply in every system;
// item eyes are remembered per system. Views (toolbar) only switch kinds and categories.
import { kindOf } from '../system.js';
import { zoneStyle } from '../visuals.js';

export const OBJ_GROUPS = [
  ['planets', 'Suns & planets', ['SUN', 'PLANET', 'MOON']],
  ['stations', 'Stations & docking', ['STATION', 'DOCKING_RING', 'AIRLOCK_GATE']],
  ['gates', 'Jump gates & holes', ['JUMP_GATE', 'JUMP_HOLE']],
  ['lanes', 'Trade lanes', ['TRADELANE_RING']],
  ['platforms', 'Platforms & satellites', ['WEAPONS_PLATFORM', 'DESTROYABLE_DEPOT', 'SATELLITE', 'MISSION_SATELLITE']],
  ['other', 'Other objects', null],
];
export const ZONE_GROUPS = [
  ['asteroids', 'Asteroid fields'], ['nebula', 'Nebulae'], ['encounter', 'Encounter zones'], ['path', 'Patrol & trade paths'],
  ['exclusion', 'Exclusion zones'], ['death', 'Death zones'], ['other', 'Other zones'],
];
const TYPE_GROUP = new Map(OBJ_GROUPS.flatMap(([id, , types]) => (types || []).map(t => [t, id])));
const KIND_KEY = { object: 'objects', zone: 'zones', light: 'lights' };

// category of an entity: 'planets' … for objects, 'asteroids' … for zones, 'lights' for lights
export function groupOf(app, s) {
  const k = kindOf(s);
  if (k === 'object') { const a = app.game.arch(s.get('archetype')); return TYPE_GROUP.get(a && a.type) || 'other'; }
  if (k === 'zone') { const n = (s.get('nickname') || '').toLowerCase(); return zoneStyle(s, app.zoneInfo && app.zoneInfo.get(n)).cat; }
  return 'lights';
}
export const kindOn = (app, kind) => app.settings[KIND_KEY[kind]] !== false;
export function groupOn(app, kind, g) {
  const S = app.settings;
  if (kind === 'object') return !(S.objHidden && S.objHidden[g]);
  if (kind === 'zone') return !S.zoneCats || S.zoneCats[g] !== false;
  return true;
}
// is the entity's kind + category switched on (the item's own eye aside)?
export function layerOn(app, s) { const k = kindOf(s); return kindOn(app, k) && groupOn(app, k, groupOf(app, s)); }

export function setKind(app, kind, on) { app.settings[KIND_KEY[kind]] = on; }
export function setGroup(app, kind, g, on) {
  const S = app.settings;
  if (kind === 'object') { S.objHidden = { ...(S.objHidden || {}) }; if (on) delete S.objHidden[g]; else S.objHidden[g] = true; }
  else if (kind === 'zone') S.zoneCats = { ...(S.zoneCats || {}), [g]: on };
}
export const groupLabel = (kind, g) => kind === 'object' ? (OBJ_GROUPS.find(x => x[0] === g) || [, 'Other objects'])[1] : kind === 'zone' ? (ZONE_GROUPS.find(x => x[0] === g) || [, 'Other zones'])[1] : 'Light sources';
