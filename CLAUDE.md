# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

High-precision **visual bounding boxes** and **SVG object tooling** powered by headless Chrome & Puppeteer.

Unlike `getBBox()` and geometry-based approaches, this toolkit uses **raster sampling through headless Chrome** to measure what actually renders in the browser. This handles:

- **Font-aware text bounds** - Complex scripts (Arabic, CJK, Tamil), ligatures, RTL/LTR, `textPath`, `tspan`
- **Filter-safe bounds** - Blur, shadows, masks, clipping, symbols, bitmap images
- **Stroke-aware bounds** - Stroke width, caps, joins, markers, patterns
- **ViewBox repair** - Fixes missing/inconsistent `viewBox`, `width`, `height`
- **Visual object catalog** - Interactive HTML for exploring, filtering, and renaming SVG objects
- **Clean cut-outs & exports** - Extract objects as standalone SVGs sized to visual bounds

**Requirements:** Node.js ≥16, Chrome/Chromium installed

## Core Architecture

### Main Library: SvgVisualBBox.js

UMD module that exposes the `SvgVisualBBox` namespace with five main functions:

1. **Two-Pass Rasterization Strategy**
   - Pass 1 (coarse): Rasterize large ROI at lower resolution to find rough bbox
   - Pass 2 (fine): Rasterize rough bbox + safety margin at high resolution for precise bbox
   - All bboxes returned in root `<svg>` user coordinate system (viewBox units)

2. **Coordinate System**
   - All measurements are in the root SVG's user units (viewBox space)
   - Results directly comparable to path coordinates, rect attributes, etc.

3. **Clipped vs Unclipped Modes**
   - `clipped`: Only measure content inside viewBox/viewport
   - `unclipped`: Measure full geometry, ignoring viewBox clipping

### Key Functions

- `waitForDocumentFonts(doc?, timeoutMs?)` - Wait for web fonts to load
- `getSvgElementVisualBBoxTwoPassAggressive(target, options?)` - High-accuracy visual bbox for single element
- `getSvgElementsUnionVisualBBox(targets[], options?)` - Union bbox for multiple elements
- `getSvgElementVisibleAndFullBBoxes(target, options?)` - Returns both clipped and unclipped bboxes
- `getSvgRootViewBoxExpansionForFullDrawing(svgRootOrId, options?)` - Compute viewBox expansion needed

### Default Options

```javascript
{
  mode: 'clipped',           // or 'unclipped'
  coarseFactor: 3,           // Pass 1 resolution multiplier
  fineFactor: 24,            // Pass 2 resolution multiplier
  safetyMarginUser: null,    // Auto-calculated if null
  useLayoutScale: true,      // Derive px/unit from getBoundingClientRect
  fontTimeoutMs: 8000        // Max wait for font loading
}
```

## Node.js Tools

All Node.js scripts require Puppeteer:
```bash
npm install puppeteer chrome-launcher
```

### test-svg-bbox.js

Test harness that runs library functions against an SVG in headless Chrome.

**Usage:**
```bash
node test-svg-bbox.js path/to/file.svg
```

**Output:**
- `<basename>-bbox-results.json` - All measurement results
- `<basename>-bbox-errors.log` - Console output and errors

### export-svg-objects.cjs

Advanced SVG object extraction/manipulation tool with four modes:

**1. LIST Mode** - Generate HTML overview with renaming UI
```bash
node export-svg-objects.cjs input.svg --list \
  [--assign-ids] [--out-fixed fixed.svg] [--out-html list.html] [--json]
```
- Creates interactive HTML table of all objects
- Client-side filters: regex, tag type, bbox area, group hierarchy
- Rename UI with validation (syntax, collision detection, row priority)
- Exports JSON mapping file for --rename mode

**2. RENAME Mode** - Apply ID renaming from JSON mapping
```bash
node export-svg-objects.cjs input.svg --rename mapping.json output.svg [--json]
```
- Updates element IDs and all references (href, xlink:href, url(#id))
- Validates ID syntax, avoids collisions, handles mapping conflicts
- Supports multiple JSON formats (array, object, or structured)

**3. EXTRACT Mode** - Extract single object
```bash
node export-svg-objects.cjs input.svg --extract id output.svg \
  [--margin N] [--include-context] [--json]
```
- Default (no --include-context): Pure cut-out, only target + ancestors
- With --include-context: Keep all objects, crop viewBox to target bbox

**4. EXPORT-ALL Mode** - Export all objects as individual SVGs
```bash
node export-svg-objects.cjs input.svg --export-all out-dir \
  [--margin N] [--export-groups] [--json]
```
- Exports path, rect, circle, ellipse, polygon, polyline, text, image, use, symbol
- With --export-groups: Also export each `<g>` with recursive children
- Each file gets its own viewBox = visual bbox + margin

### fix_svg_viewbox.js

Fix SVGs missing viewBox/width/height attributes.

**Usage:**
```bash
node fix_svg_viewbox.js input.svg [output.svg]
```
- Computes full visual bbox using library
- Sets viewBox if missing
- Synthesizes width/height from viewBox + aspect ratio
- Default output: `<input>.fixed.svg`

### render_svg_chrome.js

Render SVG to PNG with precise control over what's included.

**Usage:**
```bash
node render_svg_chrome.js input.svg output.png \
  [--mode full|visible|element] \
  [--element-id ID] \
  [--scale N] \
  [--width W --height H] \
  [--background white|transparent|#rrggbb] \
  [--margin N]
```

**Modes:**
- `full`: Render whole drawing, ignore current viewBox
- `visible` (default): Render only content inside current viewBox
- `element`: Render single element by ID, hide everything else

**Margin Behavior:**
- Applied in SVG user units
- In `visible` mode, margin is clamped to original viewBox boundaries

## Security Considerations

**CORS/Canvas Tainting:**
- Library uses `canvas.getImageData()` which requires same-origin or CORS-enabled resources
- All referenced images/fonts must be accessible or canvas becomes "tainted"
- Functions will throw clear error messages on SecurityError

## Common Patterns

### Checking if Text Fits a Shape
```javascript
const textBBox = await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive('label', {
  mode: 'clipped'
});

const fits = textBBox &&
  textBBox.x >= rect.x &&
  textBBox.y >= rect.y &&
  textBBox.x + textBBox.width <= rect.x + rect.width &&
  textBBox.y + textBBox.height <= rect.y + rect.height;
```

### Detecting Content Outside ViewBox
```javascript
const { visible, full } =
  await SvgVisualBBox.getSvgElementVisibleAndFullBBoxes('rootSvg');

const extendsOutside = full && visible && (
  full.x < visible.x ||
  full.y < visible.y ||
  full.x + full.width > visible.x + visible.width ||
  full.y + full.height > visible.y + visible.height
);
```

### Auto-Expanding ViewBox
```javascript
const expansion =
  await SvgVisualBBox.getSvgRootViewBoxExpansionForFullDrawing('mySvg');

if (expansion) {
  const vb = expansion.newViewBox;
  svgRoot.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.width} ${vb.height}`);
}
```

## Performance Notes

- Two-pass rasterization is CPU-intensive
- Avoid calling in hot loops or continuous animations
- Cache results for static elements
- Lower `coarseFactor`/`fineFactor` for better performance (less precision)
- Default factors (3, 24) are already quite aggressive for most use cases

## Complete Renaming Workflow

This is the most common workflow for organizing sprite sheets and icon libraries:

1. **Analyze SVG & assign IDs to all objects:**
   ```bash
   node export-svg-objects.cjs sprites.svg --list --assign-ids --out-fixed sprites.ids.svg
   ```
   - Produces `sprites.objects.html` (visual catalog)
   - Produces `sprites.ids.svg` (all objects have IDs like `auto_id_path_3`)

2. **Open HTML catalog in browser:**
   - File: `sprites.objects.html`
   - Use filters to explore:
     - Regex: `^auto_id_` to show auto-generated IDs
     - Tag filter: only `<g>` groups or only `<path>` elements
     - Group filter: descendants of a specific group ID
     - Area filter: objects in a specific bbox region

3. **Rename objects interactively:**
   - Type meaningful names in "New ID name" column (`icon_save`, `logo_main`, `button_primary`)
   - Check the checkbox for rows to rename
   - Fix any **red rows** (syntax issues, ID collisions, duplicates)
   - Red background = invalid; error message shown under input
   - "Save JSON with renaming" button disabled until all rows valid

4. **Export JSON mapping:**
   - Click **"Save JSON with renaming"**
   - Downloads `sprites.rename.json` with format:
     ```json
     {
       "sourceSvgFile": "sprites.svg",
       "createdAt": "2025-01-01T00:00:00.000Z",
       "mappings": [
         { "from": "auto_id_path_3", "to": "icon_save" }
       ]
     }
     ```

5. **Apply renaming to SVG:**
   ```bash
   node export-svg-objects.cjs sprites.ids.svg --rename sprites.rename.json sprites.renamed.svg
   ```
   - Updates IDs and all references (href, xlink:href, url(#id))
   - Reports applied vs skipped mappings

6. **Extract or export with stable IDs:**
   ```bash
   # Single object
   node export-svg-objects.cjs sprites.renamed.svg --extract icon_save icon_save.svg --margin 5

   # All objects
   node export-svg-objects.cjs sprites.renamed.svg --export-all exported --export-groups --margin 2
   ```

## Quick Testing & Validation

```bash
# Test library functions against an SVG
node test-svg-bbox.js drawing.svg

# Fix broken SVG (missing viewBox/width/height)
node fix_svg_viewbox.js broken.svg fixed.svg

# Render to PNG
node render_svg_chrome.js drawing.svg preview.png --mode visible --scale 2 --background transparent
```

## Critical Implementation Details

### HTML Preview Rendering (`export-svg-objects.cjs --list`)

The HTML object catalog uses `<use href="#element-id" />` to reference elements from a hidden SVG container. This requires careful handling of transforms to ensure accurate previews.

**CRITICAL BUG TO AVOID: `<use>` does NOT inherit parent group transforms!**

#### The Problem

When an SVG element has parent groups with transforms, the `<use>` element ONLY applies the element's local transform, NOT the parent transforms.

**Example:**
```xml
<!-- Original SVG structure -->
<g id="g37" transform="translate(-13.613145,-10.209854)">
  <text id="text8" transform="scale(0.86535508,1.155595)">Λοπ</text>
</g>

<!-- In original: final transform = translate(...) scale(...) ✓ -->
<!-- With <use>: only applies scale(...) ✗ WRONG! -->
```

When HTML preview does `<use href="#text8" />`, it applies:
- ✓ text8's local `scale(0.86535508,1.155595)`
- ✗ **MISSING** g37's parent `translate(-13.613145,-10.209854)`

**Result:** Preview appears shifted/mispositioned compared to original SVG.

#### The Solution

Wrap `<use>` in a `<g>` element with collected parent transforms:

```html
<!-- CORRECT: Apply parent transforms explicitly -->
<svg viewBox="-455.64 1474.75 394.40 214.40">
  <g transform="translate(-13.613145,-10.209854)">
    <use href="#text8" />
  </g>
</svg>
```

Now the transform chain is complete:
1. Parent translate (applied to wrapper `<g>`)
2. Element scale (from text8's local transform)
3. Element content

**Implementation:** The code collects all ancestor group transforms during SVG analysis and stores them in `parentTransforms` object. When generating HTML previews, it wraps `<use>` elements in `<g transform="...">` if parent transforms exist.

#### Other HTML Preview Requirements

1. **Remove viewBox from hidden container SVG:** The root SVG in the hidden container must have NO `viewBox`, `width`, `height`, `x`, or `y` attributes. These constrain the coordinate system and cause preview viewBoxes to be clipped incorrectly.

2. **Preview SVGs use only viewBox:** Preview `<svg>` elements should use `viewBox` only (no `width`/`height` attributes in user units). CSS `max-width` and `max-height` handle display sizing.

3. **Coordinate precision:** BBox measurements use the full precision of the library (typically 6-8 decimal places) to ensure pixel-perfect alignment.

## Troubleshooting

### Puppeteer/Browser Launch Fails
- Ensure Chrome/Chromium is installed
- Install default Chromium: `npx puppeteer browsers install chrome`
- Or set `PUPPETEER_EXECUTABLE_PATH` to your Chrome binary

### Fonts Look Wrong / Text BBox is Off
- Headless browser must load fonts:
  - Web fonts (`@font-face`): URLs must be reachable
  - System fonts: Install on machine running scripts
- Tools call `waitForDocumentFonts` before sampling, but flaky hosting causes issues

### External Images Not Showing
- `<image>` href/xlink:href URLs must be reachable from headless browser
- Local file URLs may need adjustment (`file://` vs relative paths)
- Firewalls/CI restrictions may block remote HTTP requests

### Large/Complex SVGs are Slow
- Sampling is intentionally aggressive for accuracy
- To reduce: lower `coarseFactor`/`fineFactor` or reduce safety margins
- For bulk processing: use powerful machine or split SVGs into smaller parts

### BBox Doesn't Match Expectations
- Decide what you want:
  - **Full drawing** (ignore viewBox) → use `mode: 'full'` or `'unclipped'`
  - **Only visible area** (respect viewBox) → use `mode: 'visible'` or `'clipped'`
  - **Only one object** → use extract or element mode
- Remember: **filters** and **strokes** extend far beyond underlying paths

## Important Limitations

- Text layout can shift as fonts load; use `waitForDocumentFonts()` or `fontTimeoutMs`
- Accuracy depends on resolution (higher `fineFactor` = tighter bbox)
- `useLayoutScale=true` helps with `vector-effect="non-scaling-stroke"`
- Non-scaling strokes and other screen-dependent effects need actual layout context
