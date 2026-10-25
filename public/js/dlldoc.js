// Editable resource DLL (strings + infocards) that plugs into the editor's History/Save like an INI doc.
import { readDll, extractText, buildTree, writeDll } from './formats/dll.js';

export class DllDoc {
  constructor(index, name, path, bytes) {
    this.index = index; this.name = name; this.path = path;
    this.key = 'dll:' + name.toLowerCase(); this.label = name;
    const { tree, imageBase, pureResource } = readDll(bytes);
    this.tree = tree; this.imageBase = imageBase;
    const { strings, infocards, lang } = extractText(tree);
    this.strings = strings; this.infocards = infocards; this.lang = lang;
    // never rebuild resources.dll (index 0, has code) or any DLL with code/exports (e.g. a mod plugin listed under [Resources])
    this.editable = index > 0 && pureResource;
    this.readOnlyReason = index === 0 ? 'resources.dll is the engine\'s own DLL (contains code)' : !pureResource ? 'contains code/exports (plugin DLL) — rebuilding would break it' : '';
    this.listeners = [];
    const self = this;
    // adapter used by History (snapshot/restore) and App.save (toBytes)
    this.ini = {
      sections: [true],
      snapshot: () => ({ s: new Map(self.strings), i: new Map(self.infocards) }),
      restore: (snap) => { self.strings = new Map(snap.s); self.infocards = new Map(snap.i); self.changed(); },
      toBytes: () => self.build(),
    };
  }
  onChange(fn) { this.listeners.push(fn); }
  changed() { for (const f of this.listeners) f(this); }
  globalId(local) { return (this.index << 16) | local; }

  build() {
    if (!this.editable) throw new Error(`${this.name} is read-only: ${this.readOnlyReason}`);
    const out = writeDll(buildTree(this.tree, this.strings, this.infocards, this.lang), this.imageBase);
    // verify: the bytes we are about to write must read back to exactly what is in the editor
    const back = extractText(readDll(out).tree);
    const same = (a, b) => { const fa = [...a].filter(([, v]) => v); const fb = [...b].filter(([, v]) => v); return fa.length === fb.length && fa.every(([k, v]) => b.get(k) === v); };
    if (!same(this.strings, back.strings) || !same(this.infocards, back.infocards)) throw new Error(`${this.name}: verification after rebuild failed — not saved`);
    return out;
  }

  usedLocal(local) { return this.strings.has(local) || this.infocards.has(local); }
  // New ids: scanning every DLL could hand out ids in resources.dll; here we
  // allocate after the highest id in use within the chosen DLL, never 0, never past 0xFFFF.
  allocLocal() {
    let hi = 0;
    for (const k of this.strings.keys()) if (k > hi) hi = k;
    for (const k of this.infocards.keys()) if (k > hi) hi = k;
    for (let i = hi + 1; i <= 0xFFFF; i++) if (!this.usedLocal(i)) return i;
    for (let i = 1; i <= hi; i++) if (!this.usedLocal(i)) return i;
    throw new Error(`${this.name} is full (65535 ids)`);
  }
}
