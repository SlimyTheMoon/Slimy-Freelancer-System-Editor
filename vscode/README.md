# Freelancer System Editor for VS Code

Runs the Freelancer System Editor (3D system and universe editing, asteroid fields and nebulae, encounters and patrol paths, suns and rings, trade planner and markets, base characters and news, resource-DLL texts, hardpoint editor) in a VS Code tab.

## Use
* **Command palette → "Freelancer: Open System Editor".**
* **Right-click a system `.ini`** (Explorer, editor tab or text) → **Open in Freelancer System Editor**. The editor opens that system and selects the object or zone the cursor is in.
* In the editor: **Show in INI** (properties panel, right-click menu or Ctrl+Alt+E) opens the system file next to it, at the selected section.
* Editing an INI in VS Code reloads it in the editor automatically if you have no unsaved changes to that file there.
* The tab title shows the number of unsaved files.

## Install folder
The extension looks for a folder containing `DATA\UNIVERSE\universe.ini` in your workspace (the workspace folder itself, its parent, or a direct subfolder). If it finds none, it asks once and remembers the folder. Change it later with **Freelancer: Set Freelancer Install Folder…** or the `freelancerSystemEditor.installDir` setting.

Saving works as in the browser version: originals are backed up to `editor_backups\<session>` in the install folder on the first write of each session.

The browser version (`start.bat`) still works and uses the same files.
