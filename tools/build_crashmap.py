#!/usr/bin/env python3
"""Builds public/data/crashmap.json for the crash & log analyser.

Inputs
  * pipeline/out/<binary>/index.tsv  (Ghidra pipeline: addr, name, namespace, callconv, bytes)
  * decompiled source src/           : comment blocks that start with "// FUN_xxxxxxxx" /
    "// LAB_xxxxxxxx" right before a function definition give the reconstructed C++ name and source file
  * module image bases / sizes / timestamps of the HD Edition binaries (MODULES below, read from the PE headers)
  * log strings: every string literal passed to the game's logging calls, with file:line, so an FLSpew line
    can be traced back to the code that printed it

Usage: build_crashmap.py <pipeline/out> <decomp/src> [out.json]
"""
import json, os, re, sys, bisect

PIPE = sys.argv[1] if len(sys.argv) > 1 else 'pipeline/out'
SRC = sys.argv[2] if len(sys.argv) > 2 else 'decomp/src'
OUT = sys.argv[3] if len(sys.argv) > 3 else os.path.join(os.path.dirname(__file__), '..', 'public', 'data', 'crashmap.json')

# name -> [ImageBase, SizeOfImage, TimeDateStamp] (HD Edition EXE + DLLS\BIN)
MODULES = {
    'freelancer.exe': [0x00400000, 2945024, 1044388729], 'flserver.exe': [0x00400000, 204800, 1053536574],
    'common.dll': [0x06260000, 3424256, 1053536577], 'server.dll': [0x06CE0000, 786432, 1053536577],
    'content.dll': [0x06EA0000, 1331200, 1053536578], 'remoteclient.dll': [0x06B30000, 299008, 1053536577],
    'dalib.dll': [0x065C0000, 53248, 1053536577], 'alchemy.dll': [0x06200000, 393216, 1044389075],
    'dacom.dll': [0x065B0000, 45056, 1044389075], 'debuglib.dll': [0x065D0000, 110592, 1044389075],
    'deformable2.dll': [0x065F0000, 90112, 1044389075], 'engbase.dll': [0x06610000, 122880, 1044389075],
    'flmaterials.dll': [0x066F0000, 106496, 1044389075], 'imeui.dll': [0x06710000, 65536, 1044389075],
    'luaprofile.dll': [0x06800000, 69632, 1044389075], 'movie.dll': [0x06AC0000, 159744, 1044389075],
    'readfile.dll': [0x06B70000, 53248, 1044389075], 'remoteserver.dll': [0x06BD0000, 299008, 1044389075],
    'rendcomp.dll': [0x06C20000, 110592, 1044389075], 'rp8.dll': [0x06D60000, 503808, 1044389075],
    'rpclocal.dll': [0x06DE0000, 266240, 1044389075], 'shading.dll': [0x06EB0000, 176128, 1044389076],
    'soundmanager.dll': [0x06EE0000, 61440, 1044389076], 'soundstreamer.dll': [0x06EF0000, 86016, 1044389076],
    'system.dll': [0x06F10000, 24576, 1044389076], 'thorn.dll': [0x06F20000, 286720, 1044389076],
    'x86math.dll': [0x06F70000, 28672, 1044389076], 'ximage.dll': [0x06F80000, 28672, 1044389076],
}
# pipeline binary dir -> module key
PIPE_MOD = {'Freelancer.exe': 'freelancer.exe', 'Common.dll': 'common.dll', 'Server.dll': 'server.dll', 'alchemy.dll': 'alchemy.dll',
            'dacom.dll': 'dacom.dll', 'debuglib.dll': 'debuglib.dll', 'deformable2.dll': 'deformable2.dll', 'engbase.dll': 'engbase.dll',
            'flmaterials.dll': 'flmaterials.dll'}
# decompiled source dir -> module key (for addresses found in the source)
SRC_MOD = {'freelancer': 'freelancer.exe', 'Common': 'common.dll', 'Server': 'server.dll', 'Content': 'content.dll', 'alchemy': 'alchemy.dll',
           'dacom': 'dacom.dll', 'EngBase': 'engbase.dll', 'Deformable2': 'deformable2.dll', 'flmaterials': 'flmaterials.dll', 'DALib': 'dalib.dll',
           'Thorn': 'thorn.dll', 'Shading': 'shading.dll', 'RendComp': 'rendcomp.dll', 'RP8': 'rp8.dll', 'ReadFile': 'readfile.dll', 'system': 'system.dll',
           'x86math': 'x86math.dll', 'ximage': 'ximage.dll', 'SoundManager': 'soundmanager.dll', 'SoundStreamer': 'soundstreamer.dll',
           'RemoteClient': 'remoteclient.dll', 'RemoteServer': 'remoteserver.dll', 'rpclocal': 'rpclocal.dll', 'imeui': 'imeui.dll', 'movie': 'movie.dll',
           'luaprofile': 'luaprofile.dll', 'FLServer': 'flserver.exe'}

def mod_of_addr(a, hint=None):
    if hint and hint in MODULES:
        b, sz, _ = MODULES[hint]
        if b <= a < b + sz: return hint
    for m, (b, sz, _) in MODULES.items():
        if m.endswith('.dll') and b <= a < b + sz: return m
    return hint

funcs = {m: {} for m in MODULES}   # module -> rva -> [size, ghidra name, cpp name, src]
for d, m in PIPE_MOD.items():
    p = os.path.join(PIPE, d, 'index.tsv')
    if not os.path.exists(p): continue
    base = MODULES[m][0]
    for line in open(p, encoding='utf-8', errors='replace').read().splitlines()[1:]:
        c = line.split('\t')
        if len(c) < 5: continue
        try: a = int(c[0], 16); sz = int(c[4])
        except ValueError: continue
        nm = c[1] if c[2] in ('Global', '') else f'{c[2]}::{c[1]}'
        funcs[m][a - base] = [sz, nm, '', '']

DEF = re.compile(r'^\s*(?:[\w:<>,\*&~\s]+?\s+)?((?:[A-Za-z_]\w*::)*~?[A-Za-z_]\w*)\s*\([^;]*$')
ADDR = re.compile(r'^\s*//\s*(?:FUN|LAB|thunk_FUN)_([0-9a-fA-F]{8})\b')
logfmt = []   # [text, file:line]
LOGCALL = re.compile(r'\b(?:Dbg|FDUMP|FDump|DEBUG_?PRINT|Trace|TRACE|ConsolePrint|SpewWarning|ErrorMsg|LogError|LogWarning|Spew\w*|Dump\w*|OutputDebugString\w*)\s*\(([^;]*)')
n_src = 0
for root, _, fs in os.walk(SRC):
    if 'vendor' in root or 'lua32' in root: continue
    top = os.path.relpath(root, SRC).split(os.sep)[0]
    hint = SRC_MOD.get(top)
    for f in fs:
        if not f.endswith(('.cpp', '.h', '.c')): continue
        path = os.path.join(root, f); rel = os.path.relpath(path, SRC).replace(os.sep, '/')
        lines = open(path, encoding='latin1').read().splitlines()
        pending = None
        for i, line in enumerate(lines):
            m = ADDR.match(line)
            if m and pending is None: pending = (int(m.group(1), 16), i); continue
            if pending is not None:
                if line.strip().startswith('//') or not line.strip():
                    if i - pending[1] > 25: pending = None
                    continue
                d = DEF.match(line)
                if d and not re.match(r'^\s*(if|for|while|switch|return|else)\b', line):
                    a = pending[0]; mod = mod_of_addr(a, hint)
                    if mod in funcs:
                        rva = a - MODULES[mod][0]
                        e = funcs[mod].setdefault(rva, [0, f'FUN_{a:08x}', '', ''])
                        if not e[2]: e[2] = d.group(1); e[3] = f'{rel}#L{i + 1}'; n_src += 1
                pending = None
            for lm in LOGCALL.finditer(line):
                for s in re.findall(r'"((?:[^"\\]|\\.){6,200})"', lm.group(1)):
                    if re.search(r'[A-Za-z]{3}', s): logfmt.append([s, f'{rel}#L{i + 1}'])

out = {'about': 'Function map for crash offsets: addresses/sizes from the Ghidra pipeline, C++ names and source files from the decompilation.',
       'modules': {m: {'base': b, 'size': sz, 'timestamp': ts} for m, (b, sz, ts) in MODULES.items()},
       'funcs': {m: sorted([[rva] + v for rva, v in fm.items()]) for m, fm in funcs.items() if fm},
       'logs': sorted({tuple(x) for x in logfmt})}
os.makedirs(os.path.dirname(os.path.abspath(OUT)), exist_ok=True)
json.dump(out, open(OUT, 'w'), separators=(',', ':'))
print({m: len(v) for m, v in out['funcs'].items()}, 'named from source:', n_src, 'log strings:', len(out['logs']))
