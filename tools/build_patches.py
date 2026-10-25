#!/usr/bin/env python3
"""Builds public/data/patches.json: community binary patches for Freelancer,
each verified against an actual install: byte edits must match the original or patched bytes; value edits record the
value found in the install. Usage: build_patches.py <install dir>"""
import json, struct, sys, os
INSTALL = sys.argv[1] if len(sys.argv) > 1 else 'Freelancer'
B = lambda s: s  # hex text
P = []
def patch(id, cat, title, module, edits, desc='', author=''):
    P.append(dict(id=id, category=cat, title=title, module=module, edits=edits, desc=desc, author=author))
def e(off, orig, new): return dict(off=off, orig=orig, new=new)
def v(off, typ, suggest=None, label=''): return dict(off=off, type=typ, suggest=suggest, label=label)

# ---- interface / HUD
patch('typing-sound', 'Interface', 'No UI typing sounds', 'freelancer.exe', [e(0x18B147, 'E8 04 95 FD FF', '90 90 90 90 90')], 'Removes the call that plays the character typing sound for UI text.', 'BC46')
patch('arrival-typing', 'Interface', 'No typing effect on arrival text', 'freelancer.exe', [e(0x05AC3D, 'FC', 'FF')], 'System/zone arrival text appears at once.', 'Adoxa')
patch('target-typing', 'Interface', 'No typing effect on target names', 'freelancer.exe', [e(o, '01', '00') for o in (0x0E111B, 0x0E11AF, 0x0E1A61, 0x0E21CF, 0x0E32B6, 0x0E32CA, 0x0E47B2, 0x0E47C6)], 'Target ship and sub-target names appear at once (all eight sites).', 'Adoxa')
patch('auto-infocards', 'Interface', 'No automatic infocards', 'freelancer.exe', [e(0x0840B3, '0F 84', '90 E9')], 'Stops infocards popping up automatically.')
patch('auto-rename', 'Interface', 'Keep names of marked objects', 'freelancer.exe', [e(0x0D3180, 'E6', '00')], 'Disables the automatic renaming of marked objects.')
patch('lead-unselected', 'Interface', 'Lead indicator for unselected targets', 'freelancer.exe', [e(0x0EC286, '0F 84', '90 E9'), e(0x0EC288, '2A 01', '00 00')], 'Shows the aiming lead indicator also when nothing is selected.')
patch('lead-solars', 'Interface', 'Lead red X on solars', 'freelancer.exe', [e(0x0F045B, '86 01', '00 00')], 'Displays the aiming lead red X on solars too.')
patch('waypoint-size', 'Interface', 'Waypoint size', 'freelancer.exe', [v(0x1D97B4, 'f', None, 'size')], 'Size of the waypoint marker.')
patch('navmap-zoom', 'Interface', 'System navmap zoom', 'freelancer.exe', [v(0x1D3F28, 'd', None, 'zoom amount')], 'How far the system navmap zooms in.')
patch('navmap-limit', 'Interface', 'Navmap map limits', 'freelancer.exe', [v(0x1D3C48, 'd', None, 'limit A'), v(0x1D3C50, 'd', None, 'limit B'), v(0x1D3164, 'f', None, 'limit C'), v(0x1D314C, 'f', None, 'limit D'), v(0x1D3168, 'f', None, 'limit E')], 'Values that bound the navmap; raise them for systems larger than vanilla.')
patch('scanner-solars', 'Interface', 'Scanner range for special solars', 'freelancer.exe', [v(0x213EC4, 'f', None, 'range')], 'Detection range of special solars on the scanner.')
patch('light-show', 'Visuals', 'Show distance of equipped lights', 'freelancer.exe', [v(0x213EC8, 'f', 10000, 'distance')], 'Raises the show limit for equipped lights (used for flare stars).')
patch('mp-button', 'Interface', 'Hide the Multiplayer button', 'freelancer.exe', [e(0x166C2B, '75', 'EB')], 'Removes the multiplayer game button from the main menu.')
patch('shake-under-fire', 'Camera', 'No screen shake under fire', 'freelancer.exe', [e(0x11DB44, '74', 'EB')], 'Disables the camera shake when your ship is hit.')
patch('shake-amount', 'Camera', 'Screen shake strength', 'freelancer.exe', [v(0x11DB5C, 'f', None, 'shake A'), v(0x11DB89, 'f', None, 'shake B')], 'Strength of the screen shake under fire.')
patch('turret-roll', 'Camera', 'No auto-roll in turret view', 'freelancer.exe', [e(0x0DBE10, '94', '95'), e(0x11A1D3, '94', '95')], 'Stops the ship rolling automatically while in turret view.')
patch('cruise-hud', 'Flight', 'Cruise speed shown on the HUD', 'freelancer.exe', [v(0x1D7E80, 'f', 600, 'cruise speed (HUD)')], 'Speed used by the HUD to show and check cruise. Change together with the cruise speed in constants.ini / common.dll.')
patch('nebula-distance', 'Visuals', 'Larger nebula exclusion zones / render distance', 'freelancer.exe', [e(0x11C3D3, '75', 'EB'), v(0x1D15B8, 'f', None, 'distance²')], 'Lets nebula exclusion zones and rendering reach further.')
patch('cutscene-aspect', 'Visuals', 'Cutscene aspect ratio', 'freelancer.exe', [v(0x1C9020, 'f', None, 'aspect')], 'Aspect ratio used for cinematics (1.85 by default).')
patch('fps-25', 'Fixes', 'Framerate lock at 25 fix', 'freelancer.exe', [e(0x158A14, 'D9 1D 0C 0A 61 00', '90 90 90 90 90 90')], 'Fixes the framerate randomly locking at 25.')
patch('background-run', 'Fixes', 'Keep running in the background', 'freelancer.exe', [e(0x1B2665, '74', 'EB')], 'Freelancer keeps running when its window loses focus.')
patch('equip-cargo', 'Rules', 'Equipment uses no cargo space', 'freelancer.exe', [e(0x0838AF, '74', 'EB')], 'Mounted equipment no longer takes up cargo space (see linked topic).')
patch('ship-class', 'Rules', 'Ignore ship class for equipment', 'freelancer.exe', [e(0x07C943, '0F 87', '90 E9')], 'Removes the ship class restriction when buying equipment.')
patch('sp-levels', 'Rules', 'No level requirements (open single player)', 'freelancer.exe', [e(o, '74', 'EB') for o in (0x080499, 0x082E95, 0x0B948D)], 'Removes level requirements for ships and equipment in open single player.')
patch('rank-even', 'Rules', 'Evenly incremented rank', 'freelancer.exe', [e(0x06FA17, '01', '00')], 'Rank rises evenly instead of by the vanilla table.')
patch('sell-price', 'Rules', 'Price bases pay for equipment', 'freelancer.exe', [v(0x1D0E2C, 'f', None, 'factor (client)')], 'Fraction of the price a base pays when you sell equipment. Change server.dll too.')
patch('sell-price-server', 'Rules', 'Price bases pay for equipment (server)', 'server.dll', [v(0x08AE7C, 'f', None, 'factor (server)')], 'Server side of the sell price factor.')
patch('dyn-asteroids', 'Visuals', 'Dynamic asteroids', 'freelancer.exe', [e(0x11D281, '1D', '00')], 'Linked to the dynamic asteroids topic.')
# ---- sound
patch('alt-tab-audio', 'Sound', 'Keep audio when Alt-Tabbed', 'soundmanager.dll', [e(0x00A021, '00', '80')], 'Audio keeps playing in the background. Apply together with the soundstreamer.dll patch.', 'Adoxa')
patch('alt-tab-audio-2', 'Sound', 'Keep music when Alt-Tabbed', 'soundstreamer.dll', [e(0x0018A9, '00', '80')], 'Streamed music keeps playing in the background.', 'Adoxa')
patch('no-sfx', 'Sound', 'Turn off non-music sounds', 'soundmanager.dll', [e(0x0089B8, '74', 'EB')], 'Silences everything except music.', 'Venemon')
# ---- AI / NPC
patch('npc-gunfire', 'AI', 'Fix broken NPC gunfire behaviour', 'common.dll', [e(0x038590, '83 EC 34 53 56', 'B0 01 C2 04 00')], 'Fixes NPCs that stop firing.')
patch('npc-gunfire-angle', 'AI', 'NPC gunfire angle', 'common.dll', [v(0x08A185, 'f', 0.0523599, 'angle A (rad)'), v(0x08AE95, 'f', 0.0523599, 'angle B (rad)')], 'Angle values from the same NPC gunfire fix (0.0524 rad = 3°).')
patch('npc-gate-dock', 'AI', 'NPC jump gate docking fix', 'common.dll', [e(0x08ADD7, '07', '00')], 'Fixes NPC fighters docking with jump gates (HpDockMount problems).')
patch('attack-pref', 'AI', 'Multi-line attack_preference', 'common.dll', [e(0x08E6D8, '74', 'EB')], 'Makes every attack_preference line in pilots.ini count, not only the first.')
patch('ai-cm', 'AI', 'Proper AI countermeasure use', 'common.dll', [e(0x13E52C, '04', '00')], 'NPCs use countermeasures properly.')
patch('nudge-force', 'AI', 'Object avoidance nudge force', 'common.dll', [v(0x13E6D0, 'f', 1.5, 'nudge force')], 'Object avoidance force; 1.5 disables it.')
patch('autopilot-helper', 'AI', 'Autopilot helper value', 'common.dll', [v(0x13E6D4, 'f', None, 'value')], 'Helper value used by all AI functions (autopilot).')
# (0x063650 does not match v1.1 — left out)
# patch('f3-freighter', 'Flight', 'F3 dock on freighters', 'common.dll', [e(0x063645, '60', '00'), e(0x063650, '62', '02')], 'Allows docking (F3) with freighter-type ships.')
patch('auto-cruise', 'Flight', 'Auto-cruise distance', 'common.dll', [v(0x1422F0, 'f', None, 'distance')], 'Distance used by the auto-cruise function.')
patch('cruise-engine', 'Flight', 'Cruise engine values', 'common.dll', [v(0x13F3CC, 'f', None, 'A'), v(0x13F440, 'd', None, 'B'), v(0x13F458, 'd', None, 'C'), v(0x13F448, 'd', None, 'D')], 'Cruise engine constants.')
patch('ship-shake', 'Visuals', 'Ship shaking', 'common.dll', [v(0x0EDB44, 'f', None, 'amount')], 'Ship shaking amount.')
patch('spin-dock', 'Flight', 'Docking spin speed', 'common.dll', [v(0x050527, 'f', None, 'A'), v(0x06DE13, 'f', None, 'B')], 'Ship spinning / docking speed values.')
patch('radiation-fix', 'Fixes', 'Radiation damage fix', 'common.dll', [e(o, '1E', '0E') for o in (0x04B4D2, 0x04B582, 0x04B63E)], 'Fix for radiation zone damage.')
# ---- server / content
patch('mp-undock-chatter', 'Multiplayer', 'Undock chatter in multiplayer', 'server.dll', [e(0x0173DA, '74', 'EB')], 'Enables the undock radio chatter in multiplayer.')
patch('missile-hull', 'Fixes', 'Missile explosion hull damage detection', 'server.dll', [e(0x00960C, '0C', '00')], 'Missile explosions are detected against hulls.')
patch('npc-disappear', 'Multiplayer', 'NPC disappear / effect draw distance²', 'server.dll', [v(0x086AEC, 'f', None, 'distance²')], 'Squared distance used for NPC despawn in MP, vis_beam draw distance and base friendliness on undock. 6250000 = 2500 m.')
patch('big-names', 'Interface', 'Big ship names on freighters', 'content.dll', [e(0x091A24, '03', '01')], 'Shows big ship names for freighter-type ships.')
patch('npc-spawn', 'AI', 'NPC spawning check', 'content.dll', [e(0x0C1771, '7A', 'EB')], 'From the "how NPC spawning works" topic.')
patch('max-rep', 'Rules', 'Maximum achievable reputation', 'content.dll', [v(0x11B930, 'd', None, 'max')], 'Highest reputation the player can reach.')
patch('mp-warning', 'Multiplayer', 'No Microsoft multiplayer warning', 'ebueula.dll', [e(0x0019E0, '83 EC 08', '89 F0 C3')], 'Removes the Microsoft warning dialog before multiplayer.')

def find(module):
    exe = os.path.join(INSTALL, 'EXE')
    for n in os.listdir(exe):
        if n.lower() == module.lower(): return os.path.join(exe, n)
    return None
out = []; report = []
for p in P:
    f = find(p['module'])
    if not f: report.append(f"unverified {p['id']}: {p['module']} not in this install"); p['verified'] = []; out.append(p); continue
    data = open(f, 'rb').read()
    ok = True; state = set()
    for ed in p['edits']:
        if 'orig' in ed:
            o = bytes.fromhex(ed['orig'].replace(' ', '')); n = bytes.fromhex(ed['new'].replace(' ', ''))
            cur = data[ed['off']:ed['off'] + len(o)]
            if cur == o: state.add('orig')
            elif cur == n: state.add('new')
            else: ok = False; report.append(f"MISMATCH {p['id']} {p['module']} {hex(ed['off'])}: {cur.hex(' ')} (want {ed['orig']})")
        else:
            fmt = {'f': '<f', 'd': '<d', 'i': '<i', 'b': '<B'}[ed['type']]; size = struct.calcsize(fmt)
            val = struct.unpack(fmt, data[ed['off']:ed['off'] + size])[0]
            ed['install'] = round(val, 7) if isinstance(val, float) else val
            if isinstance(val, float) and (val != val or abs(val) > 1e12 or (val != 0 and abs(val) < 1e-9)): ok = False; report.append(f"ODD {p['id']} {hex(ed['off'])} = {val}")
    p['verified'] = sorted(state)
    if ok: out.append(p)
json.dump({'source': 'Community binary patches for Freelancer.', 'patches': out}, open(os.path.join(os.path.dirname(__file__), '..', 'public', 'data', 'patches.json'), 'w'), indent=1)
print(len(out), 'of', len(P), 'verified'); print('\n'.join(report))
