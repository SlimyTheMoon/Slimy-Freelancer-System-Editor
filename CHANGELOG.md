# Changelog

All notable changes to the FL System Editor. Versions are tagged `vX.Y.Z` in this repository.

## 1.22.3 — 2026-10-26
- Universe map: the properties panel now shows the system you click on the map (editable, with an **Open system** button); clicking empty space or returning to the System tab shows the open system again.

## 1.22.2 — 2026-10-23
- Keys the game never reads are no longer marked in the properties panel.

## 1.22.1 — 2026-10-23
- Removed the "unused" badge after unread keys.

## 1.22.0 — 2026-10-22
- One layer-style visibility model: the Outliner is grouped by kind (Objects, Zones, Light sources) and category, each with an eye; an item is drawn when its kind, category and own eye are on.
- Tri-state category eyes; clicking a faded eye shows only that item.
- Views switch kind and category eyes; new **Standard** view (default) and a true **Everything**; manual changes show **Custom**.
- **◎ Only listed** draws only what the Outliner lists (search, filters).
- Shortcuts **H** (hide selection), **Shift+H** (hide everything else), **Alt+H** (show all).
- Hidden zones and lights stay visible while selected; hidden objects keep their selection box.

## 1.21.0 — 2026-10-22
- Eye buttons show why an item is not drawn (hidden by you / left out by the view / shown anyway).

## 1.20.0 — 2026-10-22
- View dropdown with checkboxes: several views can be combined.

## 1.19.2 — 2026-10-22
- Fixed numeric (Discovery-style) infocard formatting: tags now change only the properties they name, so italic and colour switch off correctly in-game; underline is switched off before line breaks.

## 1.19.1 — 2026-10-22
- Detailed notation explanation in its own dialog (ⓘ, click to open).

## 1.19.0 — 2026-10-22
- Infocard editor: notation selector (Auto / Vanilla / Discovery).

## 1.18.0 — 2026-10-22
- Calmer dark UI with neutral greys.

## 1.17.1 — 2026-10-21
- New infocards use the notation the loaded mod uses.

## 1.17.0 — 2026-10-21
- Full test pass on vanilla and Discovery: memory use when browsing many systems, TGA and palette textures, mixed line endings in INI files, unknown effect property types, empty files, faster loading of large mods.

## 1.16.0 — 2026-10-21
- Optional update-safe patches: re-apply your changes after a mod update.

## 1.15.0 — 2026-10-21
- Bulk editing of several items, view presets, user manual.

## 1.14.0 — 2026-10-21
- Eye buttons to hide individual items in the 3D view.

## 1.13.2 — 2026-10-21
- Infocard editor fixes (templates, undo, dialogs).

## 1.13.1 — 2026-10-21
- Fixed the black viewport with some mods; folder picker for the game directory.

## 1.13.0 — 2026-10-20
- Compatibility with large mods such as Discovery Freelancer.

## 1.12.0 — 2026-10-20
- Player installer for mod releases.

## 1.11.0 — 2026-10-20
- Real models in the mission map.

## 1.10.0 — 2026-10-20
- Visual infocard editor.

## 1.9.0 — 2026-10-20
- Travel-time routes, ship speed, mission wizard, server tools.

## 1.8.0 — 2026-10-20
- Character placement and animation blending, new system wizard.

## 1.7.1 — 2026-10-20
- In-game test kit.

## 1.7.0 — 2026-10-20
- Mission map, materials and textures editor, snapshots.

## 1.6.0 — 2026-10-20
- Characters, interiors, cutscene editing, factions, translation helper.

## 1.5.0 — 2026-10-20
- Model import and export, animations, cutscenes, audio, patch manager, materials, mod export/install, pre-flight check.

## 1.4.0 — 2026-10-19
- Find references and rename everywhere, playtest, spawn simulator.

## 1.3.0 — 2026-10-19
- INI key reference (tooltips, completion and hover in VS Code), mission parameters, crash and log analyser, balance tables, exact particle fields and beams.

## 1.2.0 — 2026-10-19
- Undo in dialogs, review changes, more effect types, NPC ships.

## 1.1.0 — 2026-10-19
- Infocards, ships, save games, particle effects, mission scripts, user guide.

## 1.0.0 — 2026-10-19
- First release: 3D system editor (local web app and VS Code extension) with objects, zones and lights, universe map, models and effects, string and infocard editor, zone flags, asteroid fields and nebulae, encounters and patrol paths, suns and planetary rings, trade planner and markets, base characters and news, zone drawing and a UTF file browser.
