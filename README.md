# Freelancer System Editor

A system editor for Freelancer that runs as a local web app. It reads and writes your game's INI files directly and renders systems in 3D with the real models, planets, textures and starspheres.

## Start

Double-click **`start.bat`**. A console window opens and the editor opens in your browser at http://localhost:5717. Keep the console window open while you work; close it to stop the editor. Chrome or Edge is recommended.

The editor finds `..\Freelancer HD Edition` on its own. For another install, choose **File → Game folder…** or run `start.bat "D:\Games\Freelancer"`.

Requires Node.js 18 or newer ([nodejs.org](https://nodejs.org)). Without an installed Node.js, put `node.exe` into a `runtime` folder next to `start.bat`.

## Safety

* Edits stay in memory until you press **Ctrl+S**, which saves every changed file.
* The first time a file is overwritten in a session, the original is copied to `<game>\editor_backups\<session time>\…`.
* Files you didn't change are left alone. In files you did change, lines you didn't touch are written back byte-for-byte, comments included.
* Undo and redo (Ctrl+Z / Ctrl+Y) work across every file, including multi-file operations such as jump links and bases, and also inside dialogs. The hardpoint editor and UTF browser have their own undo. Undoing back to the saved state clears the unsaved mark.

## Features

**Viewing**
* 3D view with the real `.cmp/.3db` models, planet spheres with atmospheres, and the system's starsphere.
* **Suns as in the game:** the `star_glow` and `star_center` billboards, plus spines, lens flare and lens glow drawn in screen space. The spines and flare use the size limits (`min_radius`/`max_radius`) and layout recovered from the decompiled `Freelancer.exe`. They fade out when a planet blocks the sun. Toggle: View → "Sun spines & lens flare". The object panel has a star-type picker with a live preview of the star's glow, spines and flare.
* **Planetary rings** (`ring = zone, file`) are drawn from `solar\rings\*.ini`, using the texture mapping and blend states recovered from the game. The planet panel lets you add, retarget or remove a ring and edit its file. Toggle: View → "Planet rings".
* Top-down navmap view (T) with the A–H / 1–8 grid scaled by `NavMapScale`.
* Zones are drawn by shape (sphere, ellipsoid, box, cylinder, ring) and coloured by role. Asteroid and nebula fields are tinted from their field files.
* Labels use the in-game names read from the resource DLLs, and infocards are shown in the properties panel.
* Light sources show as icons, with their range drawn when selected. You can switch between system lighting and editor lighting.
* Hardpoint display for the selected model, and particle effects (jump holes, engine glow, etc.) from the ALE files.
* Asteroid fields in 3D: the asteroid cube grid around the camera, distant billboards and the band ring, with exclusion zones honoured.
* Nebulae in 3D: exterior puffs and fill planes seen from outside, and interior clouds inside. Optional fog (View menu). Both can be switched off in View → "Asteroid fields & nebulae (3D)".

**Editing**
* Select by clicking, Shift-click or using the outliner. Move and rotate with the gizmo, in world or local space, with snapping.
* The properties panel edits the position and rotation fields, archetype (picker with a 3D preview), and every INI entry. Values are suggested from the game data: loadouts, factions, bases, stars, music, pilots, etc.
* Add, duplicate, delete, and copy/paste objects, zones and lights, including between systems.
* Rename with reference fixing. It updates `prev_ring`, `next_ring`, `parent` and field zones, and the `goto` entries in other systems.
* **Draw zones** (Create → Zone (draw on map), or Z): drag on the map to create a sphere, ellipsoid, box, cylinder or ring zone, with a plain, exclusion, death or encounter preset. Esc ends.
* Zone shape and size editor, plus `property_flags` and `visit` editors with named flags.
* **Field file editor:** selecting a zone that has an asteroid field or nebula shows its field file below the zone. It covers:
  * Field, Band, Billboards, the Cube asteroid table (with an asteroid picker), dynamic asteroids, and exclusion zones (with a zone picker and per-zone billboard, density and fog settings).
  * For nebulae: fog, exterior, light, clouds, lightning, and the puff shape lists. Shape names are suggested from the texture panels.
  * Other sections, such as LootableZone and ExclusionBand.
  * The 3D view rebuilds as you type. A warning appears when several zones share the same file.
* System properties: `[SystemInfo]`, music, ambient colour, dust, background starsphere, and the universe.ini entry.
* **Population & encounters** (zone panel): toughness, density, repop/relief times, pop type, `density_restriction` list, and the encounter list. Each encounter has an archetype picker (from `MISSIONS\ENCOUNTERS`, with a summary of its behaviour and ship classes), a level and a 0–1 chance, plus its weighted factions (with in-game names). A missing `[EncounterParameters]` entry is added for you. "Copy to…" copies a zone's whole population block to other zones, e.g. every segment of a path.
* **Patrol & trade paths:** paths are drawn in 3D as lines with direction arrows (patrol orange, trade green). The selected path is highlighted. Selecting a path zone shows its waypoint table, where you can move, insert or delete waypoints, extend by clicking, reverse, flatten, rename, set the radius and select all segments. Segment zones are rewritten to match, and segments whose waypoints did not move stay byte-identical.
* **Create → Patrol / trade path:** click waypoints in the 3D view (Shift+click snaps to an object, Enter finishes). Then choose the label, usage, radius and population, or copy them from an existing path.
* **Light falloff:** lights show a falloff graph for `attenuation` (1 / (a + b·d + c·d²)) or an `atten_curve` from `igraph.ini`, over the light's range. There are presets for 50/25/10/1 % brightness at range.
* **Search pickers (…):** on loadout (with an equipment list and in-game names), faction/reputation, base, star, music, pilot, voice, parent, prev/next ring, space dust and jump effect fields.
* **Outliner:**
  * ⚙ filters by object type, faction, zone kind, "has base" and "has loadout"; the search box also accepts `key=value` (e.g. `loadout=li_`).
  * Trade lanes are grouped into one row each ("Fort Bush ↔ Planet Pittsburgh, 7 rings"); click to select the whole lane, ▸ to expand.
* A raw INI editor for any section or whole file.

**Names & infocards (resource DLL editor)**
* Every `ids_name` / `ids_info` / `strid_name` / `tradelane_space_name` field has **✎** (edit the text), **+** (create new text with a free id) and **⌕** (pick an existing one).
* **Tools → Strings & infocards** (Ctrl+I) searches every string and infocard across all resource DLLs, with an infocard editor (plain text or raw XML) and a preview.
* The DLLs are rebuilt on Ctrl+S together with the INIs. Undo works, originals are backed up, and each rebuilt DLL is re-read and verified before it is written.
* Every resource type, id and language of the original DLL is kept. Only the strings and infocards change.
* `resources.dll`, and any DLL containing code, is read-only.
* Close Freelancer before saving, because Windows locks DLLs that are in use.
* The DLL writer keeps every resource and language of the original DLL. See `public/js/formats/dll.js`.

**Tools**
* **Trade lane generator:** builds a lane between two objects or points with evenly spaced rings, correct facing and `prev_ring`/`next_ring` chaining. It copies the loadout and reputation from an existing ring. There is also a "Straighten & align" action for existing lanes.
* **Jump connection:** creates a jump gate or jump hole pair in both systems with matching `goto` entries. Each end is placed toward the other system on the universe map.
* **Base creation:** adds a universe.ini `[Base]` and clones a template base's ini, rooms, `mbases.ini` NPC block and market entries.
* **Asteroid field / nebula:** links a zone to a field file, or clones a field file.
* **New system:** adds the universe.ini entry, creates the display-name string, and creates a system file from a template.
* **Universe map:** shows all systems and their jump links (one-way links in red). Drag a system to move it, double-click to open it, or right-click to create a new system.
* **Validation:** checks one system or all systems for encounters without `[EncounterParameters]` or factions, chances outside 0–1, unknown factions, missing encounter files, path index gaps, duplicate nicknames, unknown archetypes or stars, broken or one-way gotos, broken trade lane chains, bases missing from universe.ini, missing field zones and missing model or background files.
* **Find:** searches all systems by nickname, in-game name or archetype.
* **Model & hardpoint editor** (Assets menu, or "Hardpoints…" on an object):
  * View a `.cmp`/`.3db` with all hardpoints.
  * Add (Shift+click on the model places one on the surface), duplicate, rename, delete; move and rotate with the gizmo or numbers; switch fixed/revolute (axis, min/max); move to another part.
  * Saving rewrites the UTF file (the original is backed up) and reloads it in the 3D view.
* **Hash tool:** CreateID, faction hash, model CRC and ALE CRC for any nickname.
* **UTF file browser** (Assets menu, or "UTF…" in the hardpoint editor):
  * Shows the tree of any `.cmp/.3db/.mat/.txm/.sph/.ale/.vms` file. Value nodes appear as string, floats, ints and hex, and can be edited in place.
  * Textures show a preview, with Export .dds/.tga and Replace with a .dds/.tga.
  * You can add, rename and delete nodes, and export or replace a node's bytes from a file. Saving backs up the original.
* **Base characters & news** (Tools menu, Ctrl+B, or "Characters & news…" on a base). Edits `missions\mbases.ini` and `missions\news.ini`:
  * **Base block:** local faction, difficulty, offer count.
  * **Rooms:** density and fixtures (bartender, traders, dealers).
  * **Factions present:** weight, missions offered and their characters.
  * **Characters:**
    * name, affiliation, voice, room and appearance (body, head, hands, accessory pickers from `bodyparts.ini`);
    * rumors with story-flag ranges, reputation level and text, plus attached `rumorknowdb`;
    * bribes; information they sell (`know` + `knowdb`); missions offered.
    * New, duplicate, rename (references follow) and delete.
  * **News:** headline and story text, story-flag range, icon, logo, "show first", and the bases it appears on.
  * **Texts:** every text id has ✎/+ that opens the DLL string/infocard editor. Missing character references are flagged.
* **Trade planner & markets** (Tools menu, Ctrl+M):
  * **Routes:** every profitable commodity run in the universe, ranked by profit per minute. Travel time is estimated over the real map: cruise speed in a system, trade lanes (enter at any ring, leave at a lane end), and jump gates and holes, with configurable speeds and dock and jump times. Click a route for its system chain, jumps and lane/cruise distances, then jump to either base or its market.
  * **Commodities:** every base that sells or buys a commodity, cheapest and best first.
  * **Markets:** edit a base's commodity lines and its equipment and ships, grouped by kind (guns, shields, ammo & missiles, … ships). Each line shows the in-game name and price; you can change the price multiplier, sells / buys only, level and reputation, and add or remove lines. Only the edited `MarketGood` line changes, and Ctrl+S saves with backups and undo as usual. Bases also get a "Market…" button.

* **Ships, equipment & loadouts** (Tools menu): every ship with its model and hardpoints (hardpoint types are checked against the model), every equipment item with in-game name, price and the ships that can mount it, and loadout editing (equipment per hardpoint, cargo, duplicate).
* **Particle effects** (Assets menu): pick a `[VisEffect]` and see it live, including beams and fields exactly as `alchemy.dll` (checked against the decompiled code), particle appearances that spawn child effects and mesh appearances. Edit every emitter and appearance value: textures, blend modes, and size/alpha/colour/curve keyframes in a graph (drag points) or table, with an sparam slider, undo and redo. Saving writes the `.ale`; value-only edits leave the rest of the file byte-identical, and the writer reproduces all 625 vanilla `.ale` files exactly.
* **Mission scripts** (Tools menu): story mission triggers as a graph (activates / deactivates / watches), with editing of each trigger's condition and actions, links between triggers and entities (ships, NPCs, objective lists, dialogs, objectives, formations, solars, loot), and checks for unknown references and triggers that are never activated. Edits go through the normal undo and Ctrl+S.
* **NPC ships** (Tools menu): `[NPCShipArch]` entries of the global and per-mission `npcships.ini` — ship (3D view), loadout, level, pilot, state graph and `npc_class` tags, with checks and the mission NPCs that use each entry (renaming updates them). Reachable from the mission editor too.
* **Review changes** (File menu): every file changed since the editor first touched it — INI line diff, DLL string/infocard diff, UTF node diff — plus unsaved edits, with "Restore original" per file and a copyable summary.
* **Find references / rename everywhere** (Edit menu, Ctrl+Shift+F, "References…" on objects): every text or binary INI under DATA/EXE that names a nickname; rename changes all of them in one undoable step.
* **Playtest here** (Tools menu, F5): writes a save (from EXE\newplayer.fl) that starts in space next to the selected object with a chosen ship/equipment, optionally free roam with all gates unlocked; starts Freelancer and analyses the log when it closes.
* **Spawn simulator** (zone panel / Tools menu): Monte-Carlo of a zone's population with the game's encounter rules (Content.dll): encounter, faction, ship and group frequencies, and formations that can never spawn.
* **Balance tables** (Tools menu): guns/launchers, shields, thrusters and ships side by side, with hull/shield damage, range, speed, refire and thruster speed computed exactly as the game's dealer infocard (Freelancer.exe FUN_00484090), DPS and damage per energy; editable INI columns, column scaling for the filtered rows, CSV export.
* **Crash & log analyser** (Tools menu): crash addresses → function (≈28,000 functions from the Ghidra pipeline, 5,600+ with C++ name and source file), FLSpew.txt lines grouped and linked to the code that prints them, nickname search over all DATA INIs.
* **INI key reference**: every section/key the game reads (type, default, meaning) — tooltips in the properties panel, validation notes for keys the game never reads, add-entry suggestions, and hover/completion in VS Code.
* **Mission map (3D)** (Tools menu, "3D map" in the mission editor): a mission's ships, formations, solars, nav objectives, trigger areas (with radius), player placements, spawn positions and GotoVec waypoints in the system view; move/rotate with the gizmo or type values — only the numbers on that line change, shared undo. Real models for ships, formations (formations.ini offsets) and solars via NPC → NPCShipArch → shiparch.
* **Materials & textures** (Assets menu, "Materials…" on objects): material type, colours, opacity and texture slots with live preview; texture thumbnails, export PNG, replace/add from PNG/JPG/WebP/BMP/DDS (DXT1/DXT5 + mipmaps); per-window undo, backed-up save.
* **Player installer** (File → Mods → Export): a zip with install.cmd / uninstall.cmd / check.cmd running installer.ps1 (Windows PowerShell 5.1+): finds the game, refuses while it runs, SHA-256 checks against the originals the mod was made for, backups in mod_backups, verified copies, rollback on failure, exact uninstall.
* **Visual infocard editor**: WYSIWYG RDL editing (bold/italic/underline, rich_fonts.ini fonts, colours, alignment, templates, game-width view) with Plain text and XML modes; writes the game's own RDL style (writeRdl), untouched infocards stay byte-identical; content round trip verified on all 5,258 vanilla infocards. Fix: JUST loc="c|l|r" now aligns in previews.
* **Routes tool** (Tools menu): checks the three shortest-path files (missing sections and routes, routes over connections that no longer exist), adds/fixes or rebuilds them by travel time (cruise, trade lanes, jumps — Dijkstra over the trade planner graph) or fewest jumps; story systems (visit 128) excluded by default.
* **New mission wizard** (Tools menu): destroy / escort / patrol / courier missions from templates, as a side job in a story mission or replacing a story slot (Content.dll only runs Mission_01a…13); faction random-mission ships, new strings, reward, then fine-tune in the mission map.
* **Server tools** (Tools menu): freelancer.ini [Server], server libraries and FLHook plugins, start FLServer; newcharacter.ini start options/packages with checks; mpnewcharacter.fl starting reputations; multiplayer saves; changed files sorted into server+client / client / server with zip packages.
* **Speed**: on-demand rendering (idle 5 fps, 0.5 fps behind dialogs, paused during bulk loading); systems load 6 at a time — loading all 53 systems went from minutes to under a second in the test setup, pre-flight from 13 s to about 1 s.
* **New system wizard** (Create menu): universe entry + name, template look and sun, planets with death zones, a station with a cloned base (rooms, bar, markets), gate/hole connections (both ends), trade lanes, patrol paths with encounters, and routes added to the three shortest-path files — live universe/system preview, all undoable.
* **Characters, game-accurate placement**: floor height + animation root height, layered animation blending, root motion, generic fidgets from genericscripts.ini for bar characters.
* **In-game test kit** (Help menu): snapshot, then one visible change per editor at Manhattan (buoy + DLL names/infocard, material + DXT texture, market price, news, bartender head, bar music, text THN camera), a pass/fail checklist saved to `editor_testkit_report.txt`, and one-click revert.
* **Snapshots** (File menu): named checkpoints of every changed/added file in `editor_snapshots`, compare with the current files, restore (with an automatic safety snapshot first).
* **Mission parameters**: each Cnd_/Act_ line is edited as labelled parameter fields and checked for wrong counts and ignored words.
* **Save game viewer** (Tools menu): opens a `.fl` save (encrypted or not) and shows pilot, location, ship, equipment, cargo, reputation and statistics with in-game names. Money, rank and reputation can be changed and the save downloaded again (re-encrypted).
* **Infocards** are rendered with the game's fonts, colours and formatting everywhere they are shown.
* **Model import & export** (Assets menu): glTF/GLB/OBJ → `.3db`/`.cmp` with materials, DXT textures, levels of detail, hardpoints, moving parts and convex-hull collision `.sur` (common Freelancer naming conventions); any game model → `.glb` with textures, parts, hardpoints and hulls. Round-trip checked: geometry, parts, hardpoints and radius come back identical.
* **Animations**: the `Animation/Script` channels of `.cmp` files (docking rings, gates, rooms, ships) play in the model editor; joints can be posed by hand.
* **Cutscene player & script editor** (Assets menu): runs all 1,524 vanilla `.thn` scripts (compiled Lua 3.2 by a small VM, or text) — cameras, spatial/path animations, attachments, model animations, lights, effects, sounds and voice lines; base scripts with their room. Scripts can be edited as text and saved (decompiled text round-trips for every vanilla script).
* **Sounds & voices** (Assets menu): `[Sound]` tables, voice profiles and their lines (CreateID-keyed voice banks), every WAV; plays MP3-in-WAV, exports .wav/.mp3.
* **Patch manager** (Assets menu): 50 community hex edits, verified byte for byte against your files, each mapped to the decompiled function it changes; value patches with current values; custom patches; backups.
* **Game-accurate materials**: render states of every material type from the decompiled Shading.dll / flmaterials.dll, DACOM.INI `[MaterialMap]`, detail maps, alpha test vs blend as the game decides.
* **Mods** (File menu): export your changes as a mod `.zip` (with manifest and merge bases), install mods with per-file conflict detection and three-way INI merge, uninstall, and see overlaps between installed mods.
* **Characters**: `.dfm` bodies, heads, hands and accessories from `costumes.ini` / `bodyparts.ini`, skinned on their skeletons and animated with the `.anm` library; Assets → Characters & animations, and the appearance preview in the bar editor.
* **Base interiors** (Tools menu, "Interiors…" on a base): each room in 3D with its scripts, fixtures playing their fidget scripts and the room's bar characters; edit the mbases `[MRoom]` fixtures (pick markers in the view) and every section of the room INI.
* **Cutscene editing**: gizmo moves/rotates entities (start pose at 0 s, keys later), camera from the free view, cut to camera, draggable/resizable timeline events, event property editor, undo, save as text.
* **Faction relations** (Tools menu): initialworld.ini reputations as a colour grid with one-sided pairs outlined; edit one or both ways.
* **Translation** (Tools menu): export all DLL strings and infocards to CSV and import the translated file back in one undoable step.
* **Pre-flight check** (Tools menu, also in Playtest): all system checks, every file named in any INI, unread INI keys, ids without text, goods/market/loadout/NPC cross references; plus unused and duplicate strings and the next free id per DLL.

## User guide

`public/manual.html` (Help → User manual) walks through real jobs with screenshots: a new system, a base with a market, bulk-editing a defence grid, a side mission, and checking and shipping a mod. `public/guide.html` (F1) is the complete reference.
Help → Reference guide (F1) opens the full guide (`public/guide.html`): getting started, step-by-step recipes (base, trade lane, jump connection, new system), every tool, troubleshooting and the shortcut list.

## VS Code extension
`freelancer-system-editor-1.4.0.vsix` runs this editor in a VS Code tab. Install it with Extensions → ⋯ → Install from VSIX.
* "Freelancer: Open System Editor" opens the editor.
* Right-click a system `.ini` → "Open in Freelancer System Editor" opens that system at the object under the cursor.
* "Show in INI" (Ctrl+Alt+E) jumps from the selection to its line in the file.
* An INI edited in VS Code reloads in the editor automatically.
* The tab title shows the number of unsaved files.

The extension is built from `vscode/` with `sh vscode/build.sh`. The browser version via `start.bat` keeps working.

## Shortcuts

| Key | Action |
|---|---|
| Left / right drag, wheel | orbit / pan / zoom to cursor |
| W A S D Q E (+Shift) | fly (click the viewport first) |
| G / R / V | move gizmo / rotate gizmo / select only |
| X | toggle world/local gizmo space |
| T | toggle top (navmap) view |
| F, Home | focus selection, frame all |
| L | cycle labels |
| Ctrl+C / Ctrl+V / Ctrl+D / Del | copy / paste / duplicate / delete |
| Ctrl+Z / Ctrl+Y | undo / redo |
| Ctrl+F | find in all systems |
| Ctrl+I | strings & infocards (DLL editor) |
| Ctrl+S | save all (also inside dialogs) |
| Z | draw a zone |
| Ctrl+B / Ctrl+M | characters & news / trade planner |
| Ctrl+Alt+E | show selection in INI (VS Code) |
| F1 | user guide |
| Ctrl+Shift+F / F5 | find references & rename / playtest here |
| Shift+A, right-click | add object, context menu |

## Notes

* Tested against vanilla Freelancer and Discovery Freelancer (137 systems, 18 resource DLLs). See "Large mods" in the user guide for what differs.
* BINI (binary INI) files from a vanilla install open fine and are saved as text INI, which Freelancer reads as well.
* Model hashing uses the DACOM CRC (`src/dacom/dacom_crc.cpp`) recovered by the decompilation pipeline. Freelancer uses the same hash to link meshes and materials.

## Credits
Third-party licences: see `THIRD_PARTY_NOTICES.md`.

## Layout

```
server.js            local HTTP server (no dependencies): static files + case-insensitive file API + backups
public/index.html    UI shell
public/js/formats/   ini.js (round-trip INI/BINI), utf.js, model.js (cmp/3db/sph/mat/txm), crc.js, resources.js (DLL strings)
public/js/           main.js (app), viewport.js (three.js), visuals.js, system.js (doc model, undo), gamedata.js, validate.js
public/js/           fields.js (asteroid field / nebula rendering), paths.js (patrol paths), trade.js (markets, routing), sun.js, rings.js, shapes.js, zonemath.js, fx.js (ALE effects), dlldoc.js
public/js/ui/        panels.js (outliner, properties), picker.js, falloff.js, hardpoints.js, hashtool.js, fieldedit.js (field files), encounters.js (population, paths), trade.js (planner UI), mbases.js (characters & news), strings.js, dialogs.js (tools/wizards), universe.js (map),
                     shipedit.js + modelview.js (ships/equipment/loadouts), fxedit.js (particle effects), missionedit.js (mission scripts),
                     savegame.js (save games), balance.js, crash.js, refs.js, playtest.js, spawnsim.js, npcships.js, changes.js (review changes), utfundo.js, rdl.js (infocard rendering), utfbrowser.js, drawzone.js, starpreview.js,
                     modelimport.js (glTF/OBJ import, GLB export), thnplayer.js (cutscenes + editing), charview.js (characters), rooms.js (base interiors), factions.js, translate.js, missionmap.js, materials.js, snapshots.js, testkit.js, syswizard.js, msnwizard.js, servertools.js, rdledit.js, modinstaller.js (+ public/installer/installer.ps1), audio.js (sounds & voices), patches.js (patch manager), modtools.js (mods), preflight.js
public/js/formats/   modelwrite.js (.3db/.cmp/.sur writer, .sur reader), texcodec.js (DXT), anim.js (Cmpnd animation), dfm.js (characters), thorn.js (Lua 3.2 VM + text parser),
                     audio.js (sound index, voice banks, MP3-in-WAV), pe.js (PE headers), zip.js
public/data/          inischema.json + inistrings.json (INI reference), crashmap.json (crash analyser), patches.json (patch manager) — built by tools/*.py
public/guide.html    reference guide (Help → Reference guide, F1)
public/manual.html   user manual with walkthroughs (Help → User manual); screenshots in public/manual/
public/vendor/three  three.js r170
```
