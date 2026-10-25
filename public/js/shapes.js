// Texture shapes (TexturePanels files and tex_shape lists).
// [Shape] x, y, w, h in TexturePanels files are PIXELS of the named texture (e.g. solar\rings\shapes.ini:
// ring1 = 0, 0, 124, 1024), so they are divided by the texture size here; tex_shape / shape_name+dim
// entries are already normalised (0–1).
export function shapeTex(app, shapes, name) {
  const s = name && shapes.get(name.toLowerCase());
  if (!s) return null;
  const tex = app.rm.texture(s.texture);
  if (!tex) return null;
  let rect = [s.x, s.y, s.w, s.h];
  if (s.px) {
    const W = (tex.image && tex.image.width) || 1, H = (tex.image && tex.image.height) || 1;
    rect = [s.x / W, s.y / H, s.w / W, s.h / H];
  }
  return { tex, rect };
}
