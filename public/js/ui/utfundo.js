// Undo/redo for editors that change a UTF tree in memory (hardpoint editor, UTF browser).
// A snapshot records every node's name, payload and child list. Payloads are shared, not copied:
// these editors always replace a leaf's data array and never write into it.
// Restoring writes the values back into the same node objects, so references the editors hold
// (parts, selected node, hardpoint nodes) stay valid.
function snap(root) {
  const rec = [];
  (function walk(n) { rec.push([n, n.name, n.data, n.children ? n.children.slice() : null]); if (n.children) n.children.forEach(walk); })(root);
  return rec;
}
function restore(rec) { for (const [n, name, data, ch] of rec) { n.name = name; n.data = data; n.children = ch ? ch.slice() : null; } }

export function utfHistory(root, onRestore) {
  const states = [snap(root)];
  let i = 0, saved = 0;
  const api = {
    push() { states.length = i + 1; states.push(snap(root)); i++; if (states.length > 200) { states.shift(); i--; saved--; } },
    undo() { if (i <= 0) return false; i--; restore(states[i]); onRestore(); return true; },
    redo() { if (i >= states.length - 1) return false; i++; restore(states[i]); onRestore(); return true; },
    markSaved() { saved = i; },
    get dirty() { return i !== saved; },
    // Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z while the dialog is open; returns a detach function
    bindKeys() {
      const k = (e) => {
        if (!(e.ctrlKey || e.metaKey) || /^(input|textarea|select)$/i.test(e.target.tagName || '')) return;
        const key = e.key.toLowerCase();
        if (key === 'z' && !e.shiftKey) { e.preventDefault(); e.stopPropagation(); api.undo(); }
        else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); e.stopPropagation(); api.redo(); }
      };
      document.addEventListener('keydown', k, true);
      return () => document.removeEventListener('keydown', k, true);
    },
  };
  return api;
}
