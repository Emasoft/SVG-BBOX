# SVG-BBOX 🧩

> High-precision **visual bounding boxes** and **SVG object tooling** powered by headless Chrome & Puppeteer.

<p align="center">
  <a href="https://www.npmjs.com/package/svg-bbox"><img alt="npm version" src="https://img.shields.io/npm/v/svg-bbox?style=for-the-badge"></a>
  <a href="https://www.npmjs.com/package/svg-bbox"><img alt="npm downloads" src="https://img.shields.io/npm/dm/svg-bbox?style=for-the-badge"></a>
  <img alt="Node.js" src="https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=for-the-badge">
  <a href="https://github.com/Emasoft/SVG-BBOX/actions"><img alt="CI Status" src="https://img.shields.io/github/actions/workflow/status/Emasoft/SVG-BBOX/ci.yml?branch=main&style=for-the-badge"></a>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-yellow?style=for-the-badge"></a>
</p>

---

## ✨ What is this?

A small set of tools to measure and manipulate SVGs **as they actually render in a browser**:

- Robust **visual bounding boxes** (including text, filters, `<use>`, masks, strokes, etc.).
- Automatic **viewBox / width / height repair** for broken SVGs.
- High-quality **PNG rendering via Chrome**.
- **Object extraction & exporting** with per-object SVGs.
- Visual **HTML catalog** of all objects in an SVG, with live **ID renaming** support.

Unlike `getBBox()` and simple geometry math, this toolkit uses **raster sampling through headless Chrome**, so whatever the browser paints is what we measure.

---

## 📚 Table of Contents

- [Features](#-features)
- [Installation](#-installation)
- [Quickstart](#-quickstart)
- [How it works (diagram)](#-how-it-works-diagram)
- [Tools](#-tools)
  - [Library: `SvgVisualBBox.js`](#library-svgvisualbboxjs)
  - [Renderer: `sbb-render.cjs`](#renderer-render_svg_chromecjs)
  - [Fixer: `sbb-fix-viewbox.cjs`](#fixer-fix_svg_viewboxjs)
  - [BBox Calculator: `sbb-getbbox.cjs`](#bbox-calculator-getbboxcjs)
  - [Multi-tool: `extract_svg_objects.js`](#multi-tool-extract_svg_objectsjs)
- [Renaming workflow with the HTML viewer](#-renaming-workflow-with-the-html-viewer)
- [Troubleshooting](#-troubleshooting)
- [Contributing](#-contributing)
- [License](#-license)

---

## 💡 Features

- **Sprite sheet detection & processing**
  Automatically detects SVGs used as icon/sprite stacks and provides batch processing capabilities.

- **Font-aware text bounds**
  Works with complex scripts (Arabic, CJK, Tamil), ligatures, RTL/LTR, `textPath`, `tspan`, and more.

- **Filter-safe bounds**  
  Includes blur, shadows, masks, clipping, symbols, and bitmap images.

- **Stroke-aware bounds**  
  Takes into account stroke width, caps, joins, markers, and patterns.

- **ViewBox repair**  
  Fixes SVGs with missing or inconsistent `viewBox`, `width`, and `height`.

- **Visual object catalog**  
  Interactive HTML page that:
  - Lists all objects (`<g>`, `<path>`, `<use>`, `<text>`, etc.).
  - Shows each object clipped to its bounding box.
  - Lets you interactively rename IDs with live validation.
  - Exports a ready-to-use JSON mapping for batch renaming.

- **Clean cut-outs & exports**  
  Extract a single object or export all objects/groups as standalone SVGs, each sized exactly to its visual bounds.

---

## 📦 Installation

### Via npm (Recommended)

```bash
# Install globally for CLI commands
npm install -g svg-bbox

# Or install locally in your project
npm install svg-bbox

# Using pnpm
pnpm add svg-bbox

# Using yarn
yarn add svg-bbox
```

After installation, the following CLI commands are available:
- `sbb-getbbox` - Compute visual bounding boxes
- `sbb-export` - List, extract, and export SVG objects
- `sbb-fix-viewbox` - Fix missing viewBox/dimensions
- `sbb-render` - Render SVG to PNG
- `sbb-test` - Test library functions

### From Source

```bash
git clone https://github.com/Emasoft/SVG-BBOX.git
cd svg-bbox
pnpm install
```

### Requirements

> **CRITICAL**: You need **Node.js ≥ 18** and **Chrome or Chromium** installed.
>
> **⚠️ ONLY Chrome/Chromium are supported** — other browsers have poor SVG support.
> This library uses headless Chrome via Puppeteer for measurements, and visual verification
> must use the same browser engine to match results.

After installing, Puppeteer will automatically download a compatible Chromium browser. Alternatively, you can use your system Chrome by setting the `PUPPETEER_EXECUTABLE_PATH` environment variable.

```bash
chmod +x sbb-render.cjs
chmod +x sbb-fix-viewbox.cjs
chmod +x extract_svg_objects.js
```

---

## 🚀 Quickstart

### Render an SVG to PNG at the correct size

```bash
node sbb-render.cjs input.svg output.png --mode full --scale 4
```

- Detects the **full drawing extents**.
- Sets an appropriate `viewBox`.
- Renders to PNG at 4 px per SVG unit.

---

### Fix an SVG that has no `viewBox` / `width` / `height`

```bash
node sbb-fix-viewbox.cjs broken.svg fixed/broken.fixed.svg
```

- Computes the **full visual drawing box**.
- Writes a new SVG with:
  - `viewBox="x y width height"`
  - Consistent `width` / `height`.

---

### List all objects visually & generate a rename JSON

```bash
node extract_svg_objects.js sprites.svg --list --assign-ids --out-fixed sprites.ids.svg
```

This produces:

- `sprites.objects.html` — a visual catalog.
- `sprites.ids.svg` — a version where all objects have IDs like `auto_id_path_3`.

Open `sprites.objects.html` in a browser to see previews and define new ID names.

---

### Extract one object as its own SVG

```bash
node extract_svg_objects.js sprites.renamed.svg \
  --extract icon_save icon_save.svg \
  --margin 5
```

This creates `icon_save.svg` sized exactly to the **visual bounds** of `#icon_save` (with 5 units of padding).

---

### Export all objects as individual SVGs

```bash
node extract_svg_objects.js sprites.renamed.svg \
  --export-all exported \
  --export-groups \
  --margin 2
```

Each object `/ group` becomes its own SVG, with:

- Correct viewBox
- Includes `<defs>` for filters, patterns, markers
- Ancestor transforms preserved

---

## 🧬 How it works (diagram)

At a high level:

```mermaid
flowchart LR
  A[SVG file] --> B[Headless Chrome<br/>+ Puppeteer]
  B --> C[Inject SvgVisualBBox.js]
  C --> D[Raster sampling<br/>of SVG fragments]
  D --> E[Visual bounding boxes<br/>(in SVG units)]
  E --> F[Tools: render / fix / extract / export]
```

The **key idea** is to let the browser do all layout and rendering, then sample the output to deduce where pixels actually appear. This makes bounding boxes robust to:

- Fonts
- Filters
- Transforms
- `<use>` shadow DOM
- Mixed units and crazy coordinate systems

---

## 🛠 Tools

### Library: `SvgVisualBBox.js`

This library runs in the **browser context** (injected by Puppeteer). It exposes helpers through `window.SvgVisualBBox`.

#### `waitForDocumentFonts(document, timeoutMs)`

Waits for fonts to be ready (or a timeout) before measuring text.

```js
await SvgVisualBBox.waitForDocumentFonts(document, 8000);
```

#### `getSvgElementVisualBBoxTwoPassAggressive(element, options)`

Compute a **visual** bounding box for an element (including stroke, filters, etc.):

```js
const bbox = await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(element, {
  mode: 'unclipped',   // ignore viewBox clipping when measuring
  coarseFactor: 3,     // coarse sampling
  fineFactor: 24,      // fine sampling
  useLayoutScale: true // scale based on layout size
});

// bbox: { x, y, width, height } in SVG user units
```

#### `getSvgElementVisibleAndFullBBoxes(svgElement, options)`

Compute both:

- **visible** – what’s inside the current viewBox.
- **full** – the entire drawing, ignoring viewBox clipping.

Used by the fixer and renderer to choose between “full drawing” and “visible area inside the viewBox”.

---

### Renderer: `sbb-render.cjs`

Render SVG → PNG using Chrome + `SvgVisualBBox`.

#### Syntax

```bash
node sbb-render.cjs input.svg output.png \
  [--mode full|visible|element] \
  [--element-id someId] \
  [--scale N] \
  [--width W --height H] \
  [--background white|transparent|#rrggbb] \
  [--margin N]
```

#### Modes

- `--mode full`  
  - Ignore the SVG’s viewBox when measuring.
  - Render the **entire drawing** (full visual extent).

- `--mode visible` (default)  
  - Consider the viewBox as a clipping region.
  - Crop to the **visible content inside the viewBox**.

- `--mode element --element-id ID`  
  - Hide everything except the element with that ID.
  - Measure it visually and render a canvas just big enough for that element (+ margin).

#### Example

```bash
# Transparent PNG of what's actually visible in the viewBox
node sbb-render.cjs map.svg map.png \
  --mode visible \
  --margin 10 \
  --background transparent
```

---

### Fixer: `sbb-fix-viewbox.cjs`

Fix missing/inconsistent viewBox and sizes.

#### Syntax

```bash
node sbb-fix-viewbox.cjs input.svg [output.svg]
```

- If `output.svg` is omitted, writes `input.fixed.svg`.
- Uses `getSvgElementVisibleAndFullBBoxes` to find the full drawing bbox.
- Writes a new SVG that has:
  - `viewBox="x y width height"`
  - Reasonable `width`/`height` matching that aspect ratio.

#### Example

```bash
node sbb-fix-viewbox.cjs broken.svg fixed/broken.fixed.svg
```

---

### BBox Calculator: `sbb-getbbox.cjs`

CLI utility for computing visual bounding boxes using canvas-based measurement.

#### Syntax

**Single file:**
```bash
node sbb-getbbox.cjs <svg-file> [object-ids...] [--ignore-vbox] [--sprite] [--json <file>]
```

**Directory batch:**
```bash
node sbb-getbbox.cjs --dir <directory> [--filter <regex>] [--sprite] [--json <file>]
```

**List file:**
```bash
node sbb-getbbox.cjs --list <txt-file> [--sprite] [--json <file>]
```

#### Features

- **Whole SVG bbox**: Compute bbox for entire SVG content (respecting viewBox)
- **Multiple objects**: Get bboxes for specific elements by ID
- **Full drawing mode**: Use `--ignore-vbox` to measure complete drawing (ignoring viewBox clipping)
- **Sprite sheet detection**: Use `--sprite` to automatically detect and process icon sprites/stacks
- **Batch processing**: Process entire directories with optional regex filter
- **List files**: Process multiple SVGs with per-file object IDs from a text file
- **JSON export**: Save results as JSON for programmatic use
- **Auto-repair**: Missing SVG attributes (viewBox, width, height, preserveAspectRatio) are computed

#### Examples

```bash
# Compute whole SVG bbox
node sbb-getbbox.cjs drawing.svg

# Compute specific elements
node sbb-getbbox.cjs sprites.svg icon_save icon_load icon_close

# Get full drawing (ignore viewBox)
node sbb-getbbox.cjs drawing.svg --ignore-vbox

# Auto-detect and process sprite sheet
node sbb-getbbox.cjs sprite-sheet.svg --sprite

# Batch process directory with filter
node sbb-getbbox.cjs --dir ./icons --filter "^btn_" --json buttons.json

# Process from list file
node sbb-getbbox.cjs --list process-list.txt --json output.json
```

#### List File Format

Each line: `<svg-path> [object-ids...] [--ignore-vbox]`

```
# Process whole SVG content
path/to/icons.svg

# Process specific objects
path/to/sprites.svg icon1 icon2 icon3

# Get full drawing bbox (ignore viewBox)
path/to/drawing.svg --ignore-vbox
```

#### Sprite Sheet Detection

When using the `--sprite` flag with no object IDs specified, the tool automatically detects sprite sheets (SVGs used as icon stacks) and processes each sprite/icon separately.

**Detection criteria:**
- **Size uniformity** - Coefficient of variation < 0.3 for widths, heights, or areas
- **Grid arrangement** - Icons arranged in rows/columns with consistent spacing
- **Common naming patterns** - IDs matching `icon_`, `sprite_`, `symbol_`, `glyph_`, or numeric patterns
- **Minimum count** - At least 3 child elements

**Example output:**
```
🎨 Sprite sheet detected!
   Sprites: 6
   Grid: 2 rows × 3 cols
   Avg size: 40.0 × 40.0
   Uniformity: width CV=0.000, height CV=0.000
   Computing bbox for 6 sprites...

SVG: sprite-sheet.svg
├─ icon_1: {x: 5.00, y: 5.00, width: 40.00, height: 40.00}
├─ icon_2: {x: 80.00, y: 5.00, width: 40.00, height: 40.00}
├─ icon_3: {x: 150.00, y: 5.00, width: 40.00, height: 40.00}
└─ ... (remaining sprites)
```

#### Output Format

**Console:**
```
SVG: path/to/file.svg
├─ WHOLE CONTENT: {x: 0, y: 0, width: 100, height: 100}
├─ icon1: {x: 10, y: 10, width: 20, height: 20}
└─ icon2: {x: 50, y: 50, width: 30, height: 30}
```

**JSON** (with `--json`):
```json
{
  "path/to/file.svg": {
    "WHOLE CONTENT": {"x": 0, "y": 0, "width": 100, "height": 100},
    "icon1": {"x": 10, "y": 10, "width": 20, "height": 20},
    "icon2": {"x": 50, "y": 50, "width": 30, "height": 30}
  }
}
```

---

### Multi-tool: `extract_svg_objects.js`

A versatile tool for **listing, renaming, extracting, and exporting** SVG objects.

#### 1️⃣ List mode — `--list`

```bash
node extract_svg_objects.js input.svg --list \
  [--assign-ids --out-fixed fixed.svg] \
  [--out-html list.html] \
  [--json]
```

**What it does:**

- Scans the SVG for "objects":
  - `g`, `path`, `rect`, `circle`, `ellipse`,
  - `polygon`, `polyline`, `text`, `image`, `use`, `symbol`.
- **Automatically detects sprite sheets** - identifies SVGs used as icon/sprite stacks and provides helpful tips.
- Computes a **visual bbox** for each object.
- Generates an **HTML page**:

  - Column `#`: row number (used in warnings).
  - Column `OBJECT ID`: current `id` (empty if none).
  - Column `Tag`: element name.
  - Column `Preview`: small `<svg>` using the object’s bbox and `<use href="#id">`.
  - Column `New ID name`: text input + checkbox for renaming.

- With `--assign-ids`:
  - Objects without `id` receive auto IDs (`auto_id_path_1`, …).
  - If `--out-fixed` is given, a fixed SVG is saved with those IDs.

**HTML extras:**

- **Filters:**
  - Regex filter (ID, tag, or group IDs).
  - Tag filter (only paths, only groups, etc.).
  - Group filter (only descendants of `someGroupId`).
  - Area filter (objects whose bbox intersects a given rectangle).

- **Live rename validation:**
  - Valid SVG ID syntax: `^[A-Za-z_][A-Za-z0-9_.:-]*$`
  - No collision with existing IDs in the SVG.
  - No collision with earlier rows’ new IDs.
  - Invalid rows:
    - Get a **subtle red background**.
    - Show a red warning message under the input.
  - “Save JSON with renaming” is disabled while any row is invalid.

- **JSON export:**
  - Clicking **“Save JSON with renaming”** downloads a mapping file like:

    ```json
    {
      "sourceSvgFile": "input.svg",
      "createdAt": "2025-01-01T00:00:00.000Z",
      "mappings": [
        { "from": "auto_id_path_3", "to": "icon_save" },
        { "from": "auto_id_g_5", "to": "button_primary" }
      ]
    }
    ```

#### 2️⃣ Rename mode — `--rename`

Apply renaming rules from a JSON mapping.

```bash
node extract_svg_objects.js input.svg --rename mapping.json output.svg [--json]
```

Accepted JSON forms:

- Full payload with `mappings` (as exported by HTML).
- Bare array: `[ { "from": "oldId", "to": "newId" } ]`.
- Plain object: `{ "oldId": "newId", "oldId2": "newId2" }`.

**What happens:**

- For each mapping (in order):
  - Validates syntax & collisions.
  - If valid:
    - `id="from"` → `id="to"`.
    - Updates `href="#from"` / `xlink:href="#from"` → `#to`.
    - Updates `url(#from)` → `url(#to)` in all attributes (fills, filters, masks, etc.).
  - Invalid mappings are **skipped** and reported (reason included).

#### 3️⃣ Extract mode — `--extract`

Extract a **single object** into its own SVG.

```bash
node extract_svg_objects.js input.svg --extract someId output.svg \
  [--margin N] \
  [--include-context] \
  [--json]
```

Two modes:

- **Default (no `--include-context`)** → *pure cut-out*:
  - Keeps only:
    - Target element.
    - Its ancestor groups.
    - `<defs>` (for filters, markers, etc.).
  - No siblings or overlays.

- **With `--include-context`** → *cut-out with context*:
  - Copies all children of the root `<svg>` (so overlays & backgrounds stay).
  - Crops the root `viewBox` to the target object’s bbox (+ margin).
  - Good when you want to see the object under the same filters/overlays but cropped to its own rectangle.

#### 4️⃣ Export-all mode — `--export-all`

Export every object (and optionally groups) as separate SVGs.

```bash
node extract_svg_objects.js input.svg --export-all out-dir \
  [--margin N] \
  [--export-groups] \
  [--json]
```

- Objects considered:
  - `path`, `rect`, `circle`, `ellipse`,
  - `polygon`, `polyline`, `text`, `image`, `use`, `symbol`.
- With `--export-groups`:
  - `<g>` groups are also exported.
  - Recursively exports children within groups.
  - Even nested groups get their own SVG.

Each exported SVG:

- Has `viewBox = bbox (+ margin)`.
- Has matching `width` / `height`.
- Contains `<defs>` from the original.
- Includes the ancestor chain from the root to the object, with the object’s full subtree.

---

## 🧭 Renaming workflow with the HTML viewer

A typical end‑to‑end workflow:

1. **Analyze the SVG & give everything an ID**

   ```bash
   node extract_svg_objects.js sprites.svg \
     --list \
     --assign-ids \
     --out-fixed sprites.ids.svg
   ```

2. **Open the HTML catalog in Chrome/Chromium**

   - Open `sprites.objects.html` in **Chrome or Chromium ONLY**.
   - ⚠️ DO NOT use Safari, Firefox, Edge, or any other browser!
   - Use filters:
     - Regex `^auto_id_` to show only auto-generated IDs.
     - Tag filter to see only `<g>` groups or only `<path>` elements.
     - Group filter to focus on one part of the drawing.
     - Area filter to focus on a specific region.

3. **Enter new IDs**

   - In “New ID name”, type meaningful names (`icon_save`, `logo_main`, `button_primary`, …).
   - Tick the checkbox for rows you want to rename.
   - Fix any **red rows**:
     - Syntax issues.
     - ID already exists.
     - Duplicate new ID (lower row loses).

4. **Save JSON mapping**

   - Click **“Save JSON with renaming”**.
   - This downloads `sprites.rename.json`.

5. **Apply renaming to an SVG**

   ```bash
   node extract_svg_objects.js sprites.ids.svg \
     --rename sprites.rename.json \
     sprites.renamed.svg
   ```

6. **Extract or export with stable IDs**

   ```bash
   # One object
   node extract_svg_objects.js sprites.renamed.svg \
     --extract icon_save icon_save.svg --margin 5

   # All objects
   node extract_svg_objects.js sprites.renamed.svg \
     --export-all exported --export-groups --margin 2
   ```

---

## 🛟 Troubleshooting

### 💥 Puppeteer / browser fails to launch

- Make sure **Chrome** or **Chromium** is installed.
- If Puppeteer can't find a browser:
  - Try installing the default Chromium: `npx puppeteer browsers install chrome`.
  - Or set `PUPPETEER_EXECUTABLE_PATH` to your Chrome/Chromium binary.

**Installing Chrome/Chromium:**

- **macOS**:
  ```bash
  brew install --cask google-chrome
  # or
  brew install --cask chromium
  ```

- **Windows**:
  - Download from: https://www.google.com/chrome/
  - Or via Chocolatey: `choco install googlechrome`

- **Linux (Debian/Ubuntu)**:
  ```bash
  sudo apt install google-chrome-stable
  # or
  sudo apt install chromium-browser
  ```

- **Linux (Fedora/RHEL)**:
  ```bash
  sudo dnf install google-chrome-stable
  # or
  sudo dnf install chromium
  ```

- **Linux (Arch)**:
  ```bash
  sudo pacman -S google-chrome
  # or
  sudo pacman -S chromium
  ```

### ⚠️ Wrong browser opened

**Tools will ONLY open Chrome/Chromium** via the `--auto-open` flag.

If Chrome/Chromium is not found, you'll see an error message with installation instructions.

**CRITICAL**: Other browsers have poor SVG support. This library uses headless Chrome for
measurements, so visual verification must use the same browser engine.

### 🖋 Fonts look wrong / text bbox is off

- The headless browser must be able to load the fonts:
  - If you use web fonts (`@font-face`), check that the URLs are reachable.
  - If you rely on system fonts, install them on the machine running the scripts.
- For maximum accuracy, the tools call `SvgVisualBBox.waitForDocumentFonts` before sampling; still, flaky font hosting can cause issues.

### 🖼 External images not showing

- `<image>` `href`/`xlink:href` URLs must be reachable from the headless browser.
- Local file URLs might need adjustments (`file://` vs relative paths).
- Some environments may block remote HTTP requests (e.g., firewalls, CI restrictions).

### 🐢 Very large or complex SVGs are slow

- The sampling is intentionally **aggressive** for accuracy.
- If you fork the toolkit and customize `SvgVisualBBox.js`, you can reduce:
  - `coarseFactor` / `fineFactor`
  - Or skip some extra safety margins
- For bulk processing, consider:
  - Running on a powerful machine.
  - Splitting SVGs into smaller logical parts.

### 📐 Bbox doesn’t match your expectations

- Double-check whether you want:
  - **Full drawing** (ignore viewBox) → use “full” mode.
  - **Only visible area** (respect viewBox clipping).
  - **Only one object** (via extract or element mode).
- Remember that **filters** and **strokes** can extend far beyond the underlying path.

---

## 🤝 Contributing

PRs, issues, and ideas are welcome!

- Found an SVG that breaks the visual bbox heuristics?
- Have a nasty filter / font combo that behaves oddly?
- Want a new CLI mode or integration?

Open an issue with a **minimal test SVG** and a short description of what you expected vs what you saw.

---

## 📄 License

This project is licensed under the **MIT License**.

You’re free to:

- Use it in commercial and non-commercial projects.
- Modify and distribute it.
- Fork it and build your own specialized tooling.

See the \`LICENSE\` file for full details.
