#!/usr/bin/env python3
"""Builds public/data/inistrings.json: every string literal of the decompiled game source
that looks like an INI key. A key missing from this list is not read by name anywhere in the
reconstructed game. Usage: build_inistrings.py <decomp/src> [out.json]"""
import re, os, json, sys
SRC = sys.argv[1] if len(sys.argv) > 1 else 'decomp/src'
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(os.path.dirname(__file__), '..', 'public', 'data', 'inistrings.json')
lits = set()
for root, _, fs in os.walk(SRC):
    if 'vendor' in root or 'lua32' in root: continue
    for f in fs:
        if f.endswith(('.cpp', '.h', '.c')):
            t = open(os.path.join(root, f), encoding='latin1').read()
            for m in re.finditer(r'"([A-Za-z_][A-Za-z0-9_ .]{0,63})"', t): lits.add(m.group(1).lower())
json.dump({'about': 'All string literals of the decompiled game source that look like INI keys; a key not in this list is not read by name anywhere in the reconstructed game.', 'strings': sorted(lits)}, open(OUT, 'w'), separators=(',', ':'))
print(len(lits), 'strings')
