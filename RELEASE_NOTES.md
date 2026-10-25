# FL System Editor 1.22.2

A 3D system editor for Freelancer that runs as a local web app (and as a VS Code extension). It reads and writes the game's INI files and resource DLLs directly, with the real models, planets, effects and starspheres. Works with vanilla Freelancer (including HD Edition) and large mods such as Discovery Freelancer.

## Downloads

| File | What it is |
|---|---|
| `fl-system-editor-1.22.2-source.zip` | The editor. Unzip, then double-click `start.bat` (needs Node.js 18 or newer). |
| `freelancer-system-editor-1.22.2.vsix` | VS Code extension: *Extensions → … → Install from VSIX…* |

## Highlights of this release line

- **Layer-style visibility**: kinds, categories and items in the Outliner each have an eye; views (Standard, Everything, Defences, Zones, …) switch categories and can be combined; **H / Shift+H / Alt+H** hide the selection, hide everything else, show all; **◎ Only listed** draws only what the list shows.
- **Infocard editor**: visual, plain-text and XML modes, templates, and a notation selector (Auto / Vanilla / Discovery) with a detailed explanation; Discovery-style formatting now behaves in-game exactly as in the editor.
- **Calm dark UI** with neutral greys.
- Tested on every system, menu, tool and edit of vanilla Freelancer HD and Discovery Freelancer.

The full history of changes is in `CHANGELOG.md`; every earlier version is tagged (`v1.0.0` … `v1.22.1`).

## Notes

- Edits stay in memory until **Ctrl+S**; the first overwrite of a file in a session is backed up to `<game>\editor_backups\`.
- The game folder is chosen with **File → Game folder…** and remembered in `config.json` next to `start.bat` (not part of the repository).
- Licence: MIT (`LICENSE`). Third-party licences: `THIRD_PARTY_NOTICES.md`.
