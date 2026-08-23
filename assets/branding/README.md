# AgentRoom Spatial Portal

These generator inputs came from the AgentRoom emblem in the signed-in
[Meshy workspace](https://www.meshy.ai/workspace) on 20 August 2026.

- `AgentRoomSpatialPortalBack.png` removes the cyan chevron and amber cursor,
  then extends the navy material to every canvas edge so visionOS never exposes
  a black matte around its circular icon mask.
- `AgentRoomSpatialPortalFront.png` isolates those two glyphs with alpha.

The Meshy workspace reported 1,979,418 triangle faces and 1,021,785 vertices.
Its direct USDZ export was 74.9 MB and the intermediate GLB was 5.1 MB. The apps
use the two rendered layers instead. Keep the 3D exports out until they meet a
runtime mesh and texture budget.

Run `swift scripts/generate-app-icons.swift` from the repository root to rebuild
the visionOS icon layers, Home mark, and macOS icons.

## Derived-layer prompts

The back plate was produced in image-edit mode from the source render:

```text
Use case: precise-object-edit
Asset type: visionOS app icon background layer, 1024 by 1024 square PNG
Primary request: Remove only the translucent cyan chevron and the glossy amber cursor block from the recessed chamber. Reconstruct the dark recessed chamber cleanly behind them, preserving the navy rounded outer plate, metallic inner rim, chamber depth, lighting, shadows, camera angle, materials, proportions, and exact square composition.
Constraints: keep every part of the outer plate, inner metallic frame, and chamber unchanged; no new objects; no text; no watermark; no transparent border; keep the full canvas opaque.
```

The foreground was produced in image-edit mode from the same source:

```text
Use case: background-extraction
Asset type: visionOS app icon transparent foreground layer, 1024 by 1024 square PNG
Primary request: Isolate only the translucent cyan glass chevron and the glossy amber rounded cursor block from the reference. Preserve their exact shapes, relative positions, scale, glass refraction, highlights, bevels, lighting, and shadows.
Scene/backdrop: genuinely transparent background with alpha.
Composition/framing: keep both objects in the exact same canvas coordinates as the reference image.
Constraints: remove the navy plate, metallic rim, recessed chamber, and every background pixel; no new objects; no text; no watermark; preserve clean antialiased edges and real transparency.
```

The back plate then received a second, targeted image edit to remove the black
matte inherited from the Meshy render:

```text
Use case: precise-object-edit
Asset type: full-bleed visionOS app icon background layer, square PNG
Input image: Image 1 is the edit target
Primary request: Replace only the pure-black field surrounding the outer navy rounded portal plate. Fill every pixel from the plate outward to all four canvas edges and corners with a seamless continuation of the same dark navy plate material, subtle texture, and lighting. The finished square must be full-bleed navy with no black border, no black corner wedges, and no visible matte.
Constraints: keep the existing outer portal plate, metallic inner frame, recessed chamber, camera angle, geometry, crop, proportions, highlights, shadows, materials, and empty chamber exactly unchanged; edit only the black outside field; no new objects; no glyph; no text; no watermark; keep the canvas opaque.
```
