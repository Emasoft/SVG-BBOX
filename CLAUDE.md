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

### sbb-test.cjs

Test harness that runs library functions against an SVG in headless Chrome.

**Usage:**
```bash
node sbb-test.cjs path/to/file.svg
```

**Output:**
- `<basename>-bbox-results.json` - All measurement results
- `<basename>-bbox-errors.log` - Console output and errors

### sbb-export.cjs

Advanced SVG object extraction/manipulation tool with four modes:

**1. LIST Mode** - Generate HTML overview with renaming UI
```bash
node sbb-export.cjs input.svg --list \
  [--assign-ids] [--out-fixed fixed.svg] [--out-html list.html] [--json]
```
- Creates interactive HTML table of all objects
- Client-side filters: regex, tag type, bbox area, group hierarchy
- Rename UI with validation (syntax, collision detection, row priority)
- Exports JSON mapping file for --rename mode

**2. RENAME Mode** - Apply ID renaming from JSON mapping
```bash
node sbb-export.cjs input.svg --rename mapping.json output.svg [--json]
```
- Updates element IDs and all references (href, xlink:href, url(#id))
- Validates ID syntax, avoids collisions, handles mapping conflicts
- Supports multiple JSON formats (array, object, or structured)

**3. EXTRACT Mode** - Extract single object
```bash
node sbb-export.cjs input.svg --extract id output.svg \
  [--margin N] [--include-context] [--json]
```
- Default (no --include-context): Pure cut-out, only target + ancestors
- With --include-context: Keep all objects, crop viewBox to target bbox

**4. EXPORT-ALL Mode** - Export all objects as individual SVGs
```bash
node sbb-export.cjs input.svg --export-all out-dir \
  [--margin N] [--export-groups] [--json]
```
- Exports path, rect, circle, ellipse, polygon, polyline, text, image, use, symbol
- With --export-groups: Also export each `<g>` with recursive children
- Each file gets its own viewBox = visual bbox + margin

### sbb-fix-viewbox.cjs

Fix SVGs missing viewBox/width/height attributes.

**Usage:**
```bash
node sbb-fix-viewbox.cjs input.svg [output.svg]
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
   node sbb-export.cjs sprites.svg --list --assign-ids --out-fixed sprites.ids.svg
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
   node sbb-export.cjs sprites.ids.svg --rename sprites.rename.json sprites.renamed.svg
   ```
   - Updates IDs and all references (href, xlink:href, url(#id))
   - Reports applied vs skipped mappings

6. **Extract or export with stable IDs:**
   ```bash
   # Single object
   node sbb-export.cjs sprites.renamed.svg --extract icon_save icon_save.svg --margin 5

   # All objects
   node sbb-export.cjs sprites.renamed.svg --export-all exported --export-groups --margin 2
   ```

## Quick Testing & Validation

```bash
# Test library functions against an SVG
node sbb-test.cjs drawing.svg

# Fix broken SVG (missing viewBox/width/height)
node sbb-fix-viewbox.cjs broken.svg fixed.svg

# Render to PNG
node render_svg_chrome.js drawing.svg preview.png --mode visible --scale 2 --background transparent
```

## Critical Implementation Details

### HTML Preview Rendering (`sbb-export.cjs --list`)

The HTML object catalog uses `<use href="#element-id" />` to reference elements from a hidden SVG container for thumbnail generation. This architecture requires careful handling of transforms and coordinate systems to ensure accurate previews.

---

## ⚠️ CRITICAL BUG TO AVOID: `<use>` does NOT inherit parent group transforms!

This is the #1 most subtle and dangerous bug in SVG preview rendering. Read carefully.

---

### The Problem: Missing Parent Transforms

**Fundamental SVG Behavior:**

When an SVG element has parent groups with transforms, the `<use>` element ONLY applies the element's **local** transform attribute, NOT the parent group transforms. This is specified in the SVG specification and is NOT a browser bug - it's the correct behavior.

**Why This Causes Bugs:**

In the original SVG document, elements inherit transforms from their parent groups through the DOM hierarchy. But when you extract an element with `<use href="#element-id">`, the reference breaks the DOM hierarchy, and parent transforms are lost.

**Concrete Example from test_text_to_path_advanced.svg:**

Original SVG structure:
```xml
<svg id="root" viewBox="-480 1450 1080 1500">
  <g id="g37" transform="translate(-13.613145,-10.209854)">
    <text id="text8" transform="scale(0.86535508,1.155595)" x="-50.07" y="1466.86">
      Λοπ
    </text>
  </g>
</svg>
```

When browser renders the original SVG:
1. Apply g37's `translate(-13.613145,-10.209854)` to coordinate system
2. Apply text8's `scale(0.86535508,1.155595)` to coordinate system
3. Render text at x=-50.07, y=1466.86
4. **Final visual position:** Text appears at coordinates affected by BOTH transforms

Broken HTML preview approach:
```html
<svg viewBox="-455.64 1474.75 394.40 214.40">
  <use href="#text8" />
</svg>
```

When browser renders this `<use>` reference:
1. ✓ Apply text8's local `scale(0.86535508,1.155595)` transform
2. ✗ **SKIP** g37's `translate(-13.613145,-10.209854)` transform (NOT inherited!)
3. Render text at x=-50.07, y=1466.86
4. **Final visual position:** Text appears shifted by (-13.61, -10.21) pixels!

**Visual Result:**
- Text shifted 13.6 pixels LEFT and 10.2 pixels UP from expected position
- Right side of text gets clipped by viewBox boundary
- User sees truncated text "Λο" instead of full "Λοπ"

---

### Real-World Test Case: What Broke vs. What Worked

**Test file:** `samples/test_text_to_path_advanced.svg`

**Elements that BROKE in HTML preview** (before fix):

| Element ID | Parent Group | Parent Transform | Visual Bug |
|------------|-------------|------------------|------------|
| `text8` | `g37` | `translate(-13.613145,-10.209854)` | Shifted 13.6px left, 10.2px up - text truncated |
| `text9` | `g37` | `translate(-13.613145,-10.209854)` | Shifted 13.6px left, 10.2px up - text truncated |
| `rect1851` | `g1` | `translate(-1144.8563,517.64642)` | Shifted 1144px left, 517px down - **completely empty preview!** |

**Elements that WORKED in HTML preview** (even before fix):

| Element ID | Parent Group | Parent Transform | Why It Worked |
|------------|-------------|------------------|---------------|
| `text37` | (root SVG) | (none) | No parent group = no parent transforms to miss ✓ |
| `text2` | `g6` | `translate(0,0)` | Parent transform is identity matrix (no-op) ✓ |
| `path123` | `g99` | `translate(42,0)` then removed | Element re-positioned to compensate ✓ |

**Pattern Recognition:** ALL broken elements have non-identity parent transforms!

---

### How We Debugged This (Step-by-Step Investigation)

This bug was discovered through systematic hypothesis testing. Here's the complete debugging process:

#### **Hypothesis 1: BBox Calculation is Wrong**

**Test performed:**
```bash
# Extract text8 to individual SVG file with zero margin
node sbb-export.cjs samples/test_text_to_path_advanced.svg \
  --extract text8 /tmp/extracted_objects/text8.svg --margin 0

# Open in browser
open -a "Google Chrome" /tmp/extracted_objects/text8.svg
```

**Result:**
- Extracted SVG rendered **PERFECTLY** in browser! ✓
- Text "Λοπ" fully visible, properly positioned
- ViewBox coordinates exactly match visual bounds

**Conclusion:** BBox calculations are **100% correct**. Bug is HTML preview-specific. ✓

**Why this test was definitive:**
- Individual SVG files use the SAME viewBox coordinates as HTML preview
- Individual SVG files use the SAME `<use href="#text8">` approach
- The ONLY difference is the hidden container SVG structure
- If bbox was wrong, extracted SVG would also be wrong (but it's perfect!)

---

#### **Hypothesis 2: Hidden Container ViewBox Constrains Coordinates**

**Background:**
- Hidden container had `viewBox="0 0 1037.227 2892.792"`
- text8's bbox has x=-455.64 (negative coordinate, outside container viewBox!)
- Maybe container viewBox clips the referenced element?

**Test performed:**
```javascript
// In sbb-export.cjs, remove viewBox from hidden container
const clonedForMarkup = rootSvg.cloneNode(true);
clonedForMarkup.removeAttribute('viewBox');
clonedForMarkup.removeAttribute('width');
clonedForMarkup.removeAttribute('height');
const rootSvgMarkup = serializer.serializeToString(clonedForMarkup);
```

**Result:**
- rect1851 improved (was completely empty, now shows partial content)
- text8 and text9 **STILL BROKEN!** ✗
- Still shifted, still truncated

**Conclusion:** ViewBox removal helps but is NOT the root cause.

**Why this was important:** Proved that coordinate system constraints matter, but there's another issue.

---

#### **Hypothesis 3: Width/Height Attributes Conflict with ViewBox**

**Background:**
- Preview SVGs had both `width="120" height="120"` AND `viewBox="..."`
- Maybe the fixed pixel dimensions scale/clip the content?

**Test performed:**
```html
<!-- OLD: Both width/height and viewBox -->
<svg width="120" height="120" viewBox="-455.64 1474.75 394.40 214.40">
  <use href="#text8" />
</svg>

<!-- NEW: Only viewBox, CSS for sizing -->
<svg viewBox="-455.64 1474.75 394.40 214.40"
     style="max-width:120px; max-height:120px;">
  <use href="#text8" />
</svg>
```

**Result:**
- No change in positioning! ✗
- text8 and text9 **STILL shifted and truncated** ✗

**Conclusion:** Not the root cause.

---

#### **Hypothesis 4: `<use>` Element Doesn't Inherit Parent Transforms**

**Background:**
- User hinted: "I don't think the problem is in the use element, because other elements are displaying just fine.. ultrathink"
- Some elements work, some don't - must be something specific to the broken elements

**Investigation performed:**

Analyzed the SVG structure of working vs. broken elements:

```bash
# Extract structure of working element (text37)
<svg>
  <text id="text37" transform="matrix(...)">Perfect text</text>
</svg>
# Result: Direct child of root SVG, NO parent groups ✓

# Extract structure of broken element (text8)
<svg>
  <g id="g37" transform="translate(-13.613145,-10.209854)">
    <text id="text8" transform="scale(0.86535508,1.155595)">Λοπ</text>
  </g>
</svg>
# Result: Has parent group with NON-IDENTITY transform! ✗

# Extract structure of broken element (rect1851)
<svg>
  <g id="g1" transform="translate(-1144.8563,517.64642)">
    <path id="rect1851" .../>
  </g>
</svg>
# Result: Has parent group with LARGE transform! ✗✗
```

**Pattern discovered:**
- ✓ Elements WITHOUT parent groups → Work perfectly
- ✓ Elements WITH parent groups but identity transforms → Work perfectly
- ✗ Elements WITH parent groups and non-identity transforms → BROKEN!

**SVG Specification Check:**

From SVG 1.1 spec, section 5.6.2 "The 'use' element":
> "The 'use' element references another element and indicates that the graphical contents of that element is included/drawn at that given point in the document."

Key point: "graphical contents" includes the element's local attributes and transform, but **NOT the inherited context** (parent transforms, parent opacity, parent clipping paths, etc.)

**Verification test:**

Created minimal test case:
```html
<!-- Test: Does <use> inherit parent transform? -->
<svg viewBox="0 0 200 200">
  <defs>
    <g id="testGroup" transform="translate(50,50)">
      <rect id="testRect" x="0" y="0" width="20" height="20" fill="red"/>
    </g>
  </defs>

  <!-- Original: red square at (50, 50) -->
  <use href="#testGroup" />

  <!-- If <use> inherits parent transform: red square at (50, 50) -->
  <!-- If <use> IGNORES parent transform: red square at (0, 0) -->
  <use href="#testRect" x="100" y="0"/>
</svg>
```

**Result:** Second square appears at (100, 0), NOT at (150, 50)!

**Conclusion:** `<use href="#element">` does **NOT** apply parent group transforms! This is the root cause! ✓✓✓

---

### The Solution: Explicitly Wrap `<use>` with Parent Transforms

**Implementation:**

1. **Collect parent transforms** for each element during SVG analysis:

```javascript
const parentTransforms = {};
elements.forEach(element => {
  const transforms = [];
  let node = element.parentNode;

  // Walk up DOM tree from element to root SVG
  while (node && node !== rootSvg) {
    const transform = node.getAttribute('transform');
    if (transform) {
      transforms.unshift(transform);  // Prepend to maintain parent→child order
    }
    node = node.parentNode;
  }

  if (transforms.length > 0) {
    parentTransforms[element.id] = transforms.join(' ');
  }
});
```

2. **Wrap `<use>` in `<g>` with parent transforms** when generating HTML:

```html
<!-- CORRECT: Explicit parent transforms -->
<svg viewBox="-455.64 1474.75 394.40 214.40">
  <g transform="translate(-13.613145,-10.209854)">
    <use href="#text8" />
  </g>
</svg>
```

Now the transform chain is **complete and correct**:
1. Apply wrapper `<g>`'s `translate(-13.613145,-10.209854)` (parent from g37)
2. Apply text8's local `scale(0.86535508,1.155595)` (from element's transform attribute)
3. Render text content

This **exactly matches** the original SVG's transform inheritance chain! ✓✓✓

---

### Verification: Proof That the Fix Works

**Test performed:**
```bash
# Regenerate HTML with parent transform fix
node sbb-export.cjs samples/test_text_to_path_advanced.svg \
  --list --out-html /tmp/test.objects.html --auto-open

# Open in Chrome and inspect previously broken elements
```

**Results:**

| Element | Before Fix | After Fix | Status |
|---------|-----------|-----------|--------|
| `text8` | Shifted left, text truncated "Λο" | Perfectly positioned, full text "Λοπ" visible | ✅ **FIXED** |
| `text9` | Shifted left, text truncated | Perfectly positioned, full text visible | ✅ **FIXED** |
| `rect1851` | Completely empty (shifted 1144px offscreen) | Red dashed oval fully visible and centered | ✅ **FIXED** |
| `text37` | Working | Still working | ✅ **No regression** |
| `text2` | Working | Still working | ✅ **No regression** |

**User confirmation:** "yes, it worked!"

**Code-level verification:**

Inspected generated HTML in browser DevTools:
```html
<!-- text8 preview (after fix) -->
<div class="preview-cell">
  <svg viewBox="-455.6401353626684 1474.7539879250833 394.40409408148844 214.40390041136044"
       style="max-width:120px; max-height:120px;">
    <g transform="translate(-13.613145,-10.209854)">
      <use href="#text8" />
    </g>
  </svg>
</div>
```

Transform chain inspection:
1. ✓ Wrapper `<g>` has parent translate from g37
2. ✓ `<use>` references text8 (which has local scale)
3. ✓ Browser applies: translate → scale → render
4. ✓ Matches original SVG rendering exactly

**Comprehensive tests proving this fix:**
- See `tests/unit/html-preview-rendering.test.js` - TEST 2
- Tests single parent transform (translate shift measured precisely)
- Tests multiple nested transforms (translate → scale → rotate chain)
- Tests no parent transforms (text37 - direct child of root)
- Tests identity transform (text2 - translate(0,0) no-op)
- Tests large transform (rect1851 - shifted 1144px, appeared empty!)
- REAL-WORLD REGRESSION TEST: exact production bug (text8, text9, rect1851)
- User confirmation: "yes, it worked!" ✓

---

### Other HTML Preview Requirements

#### 1. Remove ViewBox/Dimensions from Hidden Container

**Why:** The hidden SVG container (holding all element definitions) MUST NOT have `viewBox`, `width`, `height`, `x`, or `y` attributes.

**Reason:** These attributes create a viewport coordinate system that can clip `<use>` references if the referenced element's coordinates fall outside the container's viewBox.

**Example of the bug:**
- Container has `viewBox="0 0 1037.227 2892.792"`
- Element text8 has bbox at x=-455.64 (negative X, outside container viewBox!)
- Result: Browser clips content outside container viewBox → empty preview

**Implementation:**
```javascript
const clonedForMarkup = rootSvg.cloneNode(true);
clonedForMarkup.removeAttribute('viewBox');
clonedForMarkup.removeAttribute('width');
clonedForMarkup.removeAttribute('height');
clonedForMarkup.removeAttribute('x');
clonedForMarkup.removeAttribute('y');
```

**According to SVG spec:** A `<use>` element inherits the coordinate system from its **context** (the preview SVG), NOT from the referenced element's original container. By removing the container's viewBox, we allow `<use>` to work purely with the preview SVG's viewBox.

**Comprehensive tests proving this fix:**
- See `tests/unit/html-preview-rendering.test.js` - TEST 1
- Tests elements with negative coordinates (clipped vs not clipped)
- Tests elements far outside container viewBox (text8 at x=-455.64)
- Tests all coordinate quadrants (negative/positive X/Y combinations)
- Proves faulty method clips elements, correct method shows them fully

---

#### 2. Preview SVGs Use Only ViewBox (No Width/Height in User Units)

**Implementation:**
```html
<!-- CORRECT: Only viewBox for coordinates, CSS for display size -->
<svg viewBox="-455.64 1474.75 394.40 214.40"
     style="max-width:120px; max-height:120px; display:block;">
  <g transform="translate(-13.613145,-10.209854)">
    <use href="#text8" />
  </g>
</svg>
```

**Why:** Mixing `width`/`height` attributes (in user units) with `viewBox` can cause scaling conflicts. The browser must map viewBox coordinates to width/height, potentially introducing rounding errors or aspect ratio distortions.

**Best practice:** Use `viewBox` for SVG coordinate system, use CSS for display sizing.

**Comprehensive tests proving this approach:**
- See `tests/unit/html-preview-rendering.test.js` - TEST 3
- Tests viewBox with CSS sizing preserves coordinate precision
- Tests width/height attributes can cause scaling issues
- Tests CSS sizing allows proper aspect ratio preservation (wide vs tall elements)

---

#### 3. Coordinate Precision Must Match BBox Calculation

**Why:** BBox measurements return coordinates with high precision (6-8 decimal places). ViewBox strings must preserve this precision to ensure pixel-perfect alignment.

**Implementation:**
```javascript
const viewBoxStr = `${bbox.x} ${bbox.y} ${bbox.width} ${bbox.height}`;
// Preserves full JavaScript number precision (typically 15-17 significant digits)
```

**What NOT to do:**
```javascript
// ✗ WRONG: Rounding loses precision
const viewBoxStr = `${bbox.x.toFixed(2)} ${bbox.y.toFixed(2)} ...`;

// ✗ WRONG: String concatenation may lose precision
const viewBoxStr = Math.round(bbox.x) + " " + Math.round(bbox.y) + " ...";
```

**Why precision matters:**
- At high zoom levels, even 0.01 pixel errors become visible
- Text rendering is especially sensitive to subpixel positioning
- Cumulative rounding errors across multiple transforms amplify the problem

**Comprehensive tests proving precision is critical:**
- See `tests/unit/html-preview-rendering.test.js` - TEST 4
- Tests full precision viewBox matches bbox exactly (10+ decimals preserved)
- Tests 2-decimal rounding causes measurable misalignment (~0.003px error)
- Tests integer rounding causes severe precision loss (text shifted by 0.3px = 2.4% of font size)
- Tests cumulative precision errors with multiple elements (~0.009px for third element)

---

### Summary: The Complete Fix Checklist

When generating HTML previews with `<use>` elements:

- ✅ Remove `viewBox`, `width`, `height`, `x`, `y` from hidden container SVG
- ✅ Collect all parent group transforms for each element (walk up DOM tree)
- ✅ Wrap `<use href="#id">` in `<g transform="...">` with parent transforms
- ✅ Preview SVGs use only `viewBox` (no width/height in user units)
- ✅ Preview SVGs use CSS for display sizing (`max-width`, `max-height`)
- ✅ Preserve full coordinate precision in viewBox strings
- ✅ Test with elements that have complex transform chains
- ✅ Test with elements that have negative coordinates
- ✅ Verify no regressions for elements without parent transforms

**Complete test suite verifying all fixes:**
- See `tests/unit/html-preview-rendering.test.js`
- 20+ tests covering all edge cases and faulty methods
- Integration test combining all fixes with real test_text_to_path_advanced.svg
- Proves faulty methods fail and correct methods work
- Documents all debugging hypotheses (what we tried and why it failed)
- Run tests: `npm test tests/unit/html-preview-rendering.test.js`

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
