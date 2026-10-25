#!/usr/bin/env python3
"""Builds public/data/inischema.json from an INI reference (docs/ini/*.md,
written from the reconstructed game source). Output: {sections: {lname: {name, keys: {lkey: entry}}},
groups...}. Each entry: key, type, default, meaning, page, heading, source (repo-relative path#line)."""
import json, os, re, sys
DOCS = sys.argv[1] if len(sys.argv) > 1 else 'decomp/docs/ini'
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), '..', 'public', 'data', 'inischema.json')
BT = re.compile(r'`([^`]+)`')
def clean(s):
    s = re.sub(r'\[([^\]]+)\]\(([^)]+)\)', r'\1', s)   # links -> text
    s = s.replace('<br>', '; ').strip()
    return s
def src_of(cell):
    m = re.search(r'\(\.\./\.\./(src/[^)#]+)(#L\d+)?\)', cell)
    return (m.group(1) + (m.group(2) or '')) if m else ''
GROUP_HINT = {'root::read': 'Root', 'equipment::read': 'Equipment', 'attachedequipment::read': 'AttachedEquipment', 'eqobj::read': 'EqObj'}
sections, groups = {}, {}
def add(target, isgroup, e):
    d = groups if isgroup else sections
    t = d.setdefault(target.lower(), {'name': target, 'keys': {}, 'pages': set()})
    t['pages'].add(e['page'])
    k = e['key'].lower()
    if k in t['keys']:  # same key documented on several pages (client/server): keep both meanings
        old = t['keys'][k]
        if e['meaning'] and e['meaning'] not in old['meaning']: old['meaning'] += '  ‖  ' + e['meaning']
    else: t['keys'][k] = dict(e)
for fn in sorted(os.listdir(DOCS)):
    if not fn.endswith('.md') or fn == 'README.md': continue
    page = fn[:-3]; heading = ''; targets = []; isgroup = False; cols = None
    for line in open(os.path.join(DOCS, fn), encoding='utf-8'):
        line = line.rstrip('\n')
        if line.startswith('#'):
            heading = clean(line.lstrip('#').strip()); cols = None
            h = line.lower(); grp = next((v for k, v in GROUP_HINT.items() if k in h), None)
            names = re.findall(r'`\[([^\]`]+)\]`', line)
            if not names:
                names = [n for n in BT.findall(line) if re.fullmatch(r'[A-Za-z][A-Za-z0-9_ ]*', n) and not re.search(r'\.ini$', n)]
            if grp and ('shared by' not in h):
                targets, isgroup = [grp], True
            elif grp:  # "Keys shared by `Ship` and `Solar` (`EqObj::read`)"
                targets, isgroup = [grp], True
            else:
                targets, isgroup = names, False
            if page in ('missions-actions', 'missions-conditions') and not isgroup and not names: targets = ['Trigger']
            SPECIAL = {'zone sections': ['Zone'], 'market files': ['BaseGood']}
            for k, v in SPECIAL.items():
                if k in h: targets, isgroup = v, False
            continue
        mb = re.match(r'^\*\*((?:`\[[^\]]+\]`[ ,/and]*)+)', line)
        if mb:  # paragraph-level section label: **`[Zone]`** (…)
            targets, isgroup, cols = re.findall(r'`\[([^\]`]+)\]`', mb.group(1)), False, None
            continue
        if line.startswith('|'):
            cells = [c.strip() for c in line.strip().strip('|').split('|')]
            if cols is None:
                low = [c.lower() for c in cells]
                if low and low[0].startswith('key'): cols = low
                continue
            if set(''.join(cells)) <= set('-: '): continue
            if not targets: continue
            keys = [k for k in BT.findall(cells[0]) if re.fullmatch(r'[A-Za-z_][A-Za-z0-9_ .]*', k)]
            def col(name):
                for i, c in enumerate(cols):
                    if c.startswith(name): return cells[i] if i < len(cells) else ''
                return ''
            params = []
            vcell, tcell, dcell = col('values'), col('type'), col('default')
            if vcell:
                tparts = [t.strip() for t in tcell.split('<br>')] if tcell else []
                dparts = [t.strip() for t in dcell.split('<br>')] if dcell else []
                nv = len(vcell.split('<br>'))
                aligned = len(tparts) == nv
                for i, part in enumerate(vcell.split('<br>')):
                    mm = re.match(r'\s*([0-9][0-9,\. ]*)\s*:\s*(.*)', part)
                    if not mm: continue
                    label = clean(mm.group(2))
                    params.append({'at': mm.group(1).strip(), 'label': re.sub(r'\s*\(optional[^)]*\)', '', label), 'optional': 'optional' in label.lower(),
                                   'type': clean(tparts[i]) if aligned else '',
                                   'default': clean(dparts[i]) if len(dparts) == nv else ''})
            e = {'type': clean(col('type') or col('values')), 'default': clean(col('default')),
                 'meaning': clean(col('meaning') or col('description')), 'page': page, 'heading': heading,
                 'source': src_of(col('source'))}
            if params: e['params'] = params
            if vcell and re.search(r'\bform\b', vcell, re.I): e['multiForm'] = True
            for k in keys:
                for t in targets: add(t, isgroup, dict(e, key=k))
# group membership
ARCH_PAGES = {'archetypes-and-equipment', 'archetypes-weapons', 'archetypes-ships-solars-asteroids'}
EQUIP_PAGES = {'archetypes-and-equipment', 'archetypes-weapons'}
for ln, s in sections.items():
    inc = []
    if s['pages'] & ARCH_PAGES and ln not in ('collisiongroup', 'cube', 'exclusion zones', 'lootablezone', 'object'): inc.append('root')
    if s['pages'] & EQUIP_PAGES and ln not in ('explosion', 'simple', 'motor'): inc += ['equipment', 'attachedequipment']
    if ln in ('ship', 'solar'): inc.append('eqobj')
    s['include'] = [g for g in inc if g in groups]
for d in (sections, groups):
    for s in d.values(): s['pages'] = sorted(s['pages'])
os.makedirs(os.path.dirname(OUT), exist_ok=True)
json.dump({'about': 'Generated from docs/ini by tools/build_inischema.py',
           'sections': sections, 'groups': groups}, open(OUT, 'w'), indent=0, ensure_ascii=False)
print(len(sections), 'sections', sum(len(s['keys']) for s in sections.values()), 'keys;', len(groups), 'groups', sum(len(s['keys']) for s in groups.values()), 'keys')
