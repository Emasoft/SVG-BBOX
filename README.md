<div align="center">
  <h1>SvgVisualBBox</h1>
  <h3>A JavaScript library for accurate SVG bounding box computation</h3>
  <p><em>Finally, bounding boxes you can trust.</em></p>
</div>

<p align="center">
  <a href="https://www.npmjs.com/package/svg-bbox"><img alt="npm version" src="https://img.shields.io/npm/v/svg-bbox?style=for-the-badge&logo=npm&logoColor=white&color=CB3837"></a>
  <a href="https://www.npmjs.com/package/svg-bbox"><img alt="npm downloads" src="https://img.shields.io/npm/dm/svg-bbox?style=for-the-badge&logo=npm&logoColor=white&color=CB3837"></a>
  <a href="https://bundlephobia.com/package/svg-bbox"><img alt="bundle size" src="https://img.shields.io/bundlephobia/minzip/svg-bbox?style=for-the-badge&logo=webpack&logoColor=white&label=minified"></a>
</p>

<p align="center">
  <a href="https://github.com/Emasoft/SVG-BBOX/actions"><img alt="CI Status" src="https://img.shields.io/github/actions/workflow/status/Emasoft/SVG-BBOX/ci.yml?branch=main&style=for-the-badge&logo=github&logoColor=white&label=CI"></a>
  <a href="./LICENSE"><img alt="License: MIT" src="https://img.shields.io/badge/license-MIT-yellow?style=for-the-badge&logo=opensourceinitiative&logoColor=white"></a>
  <img alt="Node.js" src="https://img.shields.io/badge/node-%3E%3D18-brightgreen?style=for-the-badge&logo=nodedotjs&logoColor=white">
  <img alt="TypeScript Ready" src="https://img.shields.io/badge/TypeScript-Ready-blue?style=for-the-badge&logo=typescript&logoColor=white">
</p>

<p align="center">
  <a href="https://unpkg.com/svg-bbox@latest/SvgVisualBBox.min.js"><img alt="unpkg CDN" src="https://img.shields.io/badge/unpkg-CDN-blue?style=flat-square&logo=unpkg"></a>
  <a href="https://cdn.jsdelivr.net/npm/svg-bbox@latest/SvgVisualBBox.min.js"><img alt="jsDelivr CDN" src="https://img.shields.io/badge/jsDelivr-CDN-orange?style=flat-square&logo=jsdelivr"></a>
  <a href="https://github.com/Emasoft/SVG-BBOX"><img alt="GitHub" src="https://img.shields.io/badge/GitHub-Repository-black?style=flat-square&logo=github"></a>
</p>

---

## The Problem with `.getBBox()`

The native SVG `.getBBox()` method is fundamentally broken:

| Feature                                 | `.getBBox()` |       **SvgVisualBBox**       |
| --------------------------------------- | :----------: | :---------------------------: |
| Filters (blur, shadows, glows)          | :x: Ignored  |  :white_check_mark: Measured  |
| Stroke width                            | :x: Ignored  |  :white_check_mark: Included  |
| Complex text (ligatures, RTL, textPath) |  :x: Wrong   |  :white_check_mark: Accurate  |
| `<use>`, masks, clipping paths          |  :x: Fails   |   :white_check_mark: Works    |
| Transformed elements                    | :x: Garbage  |  :white_check_mark: Correct   |
| Cross-browser consistency               |  :x: Varies  | :white_check_mark: Consistent |

**Our approach:** Measure what the browser actually paints, pixel by pixel. No
geometry guesswork, no lies.

### Visual Comparison: Real-World Examples

Here's what happens when extracting different SVG elements using three different
methods. Both examples demonstrate the same fundamental issues.

<table style="background-color: white; color: black; border: 1px solid black;">
  <tr>
    <th style="background-color: white; color: black; border: 1px solid black;">Inkscape BBox</th>
    <th style="background-color: white; color: black; border: 1px solid black;">Chrome <code>.getBBox()</code></th>
    <th style="background-color: white; color: black; border: 1px solid black;"><strong>SvgVisualBBox</strong></th>
  </tr>
  <tr>
    <td style="background-color: white; color: black; border: 1px solid black;"><img src="assets/text39_inkscape.png" alt="Inkscape extraction - undersized by 55%" /></td>
    <td style="background-color: white; color: black; border: 1px solid black;"><img src="assets/text39_getbbox.png" alt="Chrome getBBox - oversized vertically" /></td>
    <td style="background-color: white; color: black; border: 1px solid black;"><img src="assets/text39_svgvisualbbox.png" alt="SvgVisualBBox - pixel-perfect accuracy" /></td>
  </tr>
  <tr>
    <td align="center" style="background-color: white; color: black; border: 1px solid black;"><a href="assets/text39_inkscape.svg">SVG</a></td>
    <td align="center" style="background-color: white; color: black; border: 1px solid black;"><a href="assets/text39_getbbox.svg">SVG</a></td>
    <td align="center" style="background-color: white; color: black; border: 1px solid black;"><a href="assets/text39_svgvisualbbox.svg">SVG</a></td>
  </tr>
  <tr>
    <td style="background-color: white; color: black; border: 1px solid black;">❌ Width: 324px<br/><em>Undersized by ~55%</em><br/>Lost coordinate context</td>
    <td style="background-color: white; color: black; border: 1px solid black;">⚠️ Width: 730px<br/>Height: 74px<br/><em>Oversized vertically by 30%</em></td>
    <td style="background-color: white; color: black; border: 1px solid black;">✅ Width: 729px<br/>Height: 57px<br/><em>Pixel-perfect accuracy</em></td>
  </tr>
  <tr>
    <td colspan="3" style="background-color: white; color: black; border: 1px solid black;"><hr/><strong>Example 2: Oval Badge with Dashed Stroke</strong> (<a href="assets/test_oval_badge.svg">source SVG</a>)</td>
  </tr>
  <tr>
    <td style="background-color: white; color: black; border: 1px solid black;"><img src="assets/oval_badge_inkscape.png" alt="Inkscape - undersized width" /></td>
    <td style="background-color: white; color: black; border: 1px solid black;"><img src="assets/oval_badge_getbbox.png" alt="getBBox - missing stroke width" /></td>
    <td style="background-color: white; color: black; border: 1px solid black;"><img src="assets/oval_badge_svgvisualbbox.png" alt="SvgVisualBBox - includes full stroke" /></td>
  </tr>
  <tr>
    <td align="center" style="background-color: white; color: black; border: 1px solid black;"><a href="assets/oval_badge_inkscape.svg">SVG</a></td>
    <td align="center" style="background-color: white; color: black; border: 1px solid black;"><a href="assets/oval_badge_getbbox.svg">SVG</a></td>
    <td align="center" style="background-color: white; color: black; border: 1px solid black;"><a href="assets/oval_badge_svgvisualbbox.svg">SVG</a></td>
  </tr>
  <tr>
    <td style="background-color: white; color: black; border: 1px solid black;">❌ Width: 554px<br/>Height: 379px<br/><em>Undersized by ~48%</em></td>
    <td style="background-color: white; color: black; border: 1px solid black;">❌ Width: 999px<br/>Height: 301px<br/><em>Missing ~78px of stroke</em></td>
    <td style="background-color: white; color: black; border: 1px solid black;">✅ Width: 1077px<br/>Height: 379px<br/><em>Includes full visual bounds</em></td>
  </tr>
</table>

> **Note:** Example 1 uses the `.New York` font which may not be installed on
> your system. PNGs are provided so you can see the true rendering for both
> examples.

**Why the differences?**

- **Inkscape:** Uses font metrics that don't account for italic overflow,
  ligatures, and actual glyph rendering (Example 1). Also significantly
  undersizes elements with text, missing ~48% of width in Example 2. Recenters
  coordinates, losing the original document context.
- **`.getBBox()`:** Uses geometric calculations that completely ignore stroke
  width (Example 2: missing 78px) and approximate text bounds using font metrics
  (Example 1: wrong vertical bounds). Both demonstrate geometric vs visual
  measurement.
- **SvgVisualBBox:** Rasterizes and measures actual pixel data. Captures
  complete visual bounds including strokes, filters, and text overflow. What you
  see is exactly what you get.

---

## Quick Start

### Browser (CDN)

```html
<script src="https://unpkg.com/svg-bbox@latest/SvgVisualBBox.min.js"></script>
<script>
  (async () => {
    // Get accurate bounding box for any SVG element
    const bbox =
      await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(
        '#myElement'
      );
    console.log(bbox); // {x: 10, y: 20, width: 100, height: 50}

    // Visual debugging - show border around true bounds
    const result = await SvgVisualBBox.showTrueBBoxBorder('#myElement');
    setTimeout(() => result.remove(), 3000);
  })();
</script>
```

### Node.js / npm

```bash
npm install svg-bbox
```

```javascript
// Use with Puppeteer for server-side SVG processing
const puppeteer = require('puppeteer');

const browser = await puppeteer.launch();
const page = await browser.newPage();
await page.setContent(`<html><body>${svgContent}</body></html>`);
await page.addScriptTag({ path: 'node_modules/svg-bbox/SvgVisualBBox.js' });

const bbox = await page.evaluate(async () => {
  return await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive('svg');
});
```

---

## What This Package Provides

### 1. The Core Library: `SvgVisualBBox.js`

The heart of this package - a browser-side JavaScript library that computes
accurate visual bounding boxes using canvas rasterization.

**Key Functions:**

- `getSvgElementVisualBBoxTwoPassAggressive()` - High-accuracy bbox for any
  element
- `getSvgElementsUnionVisualBBox()` - Union bbox for multiple elements
- `getSvgElementVisibleAndFullBBoxes()` - Both clipped and unclipped bounds
- `showTrueBBoxBorder()` - Visual debugging helper
- `waitForDocumentFonts()` - Font loading synchronization

### 2. CLI Tools (Built on the Library)

Command-line utilities that leverage the library for common SVG tasks:

| Tool              | Purpose                                         |
| ----------------- | ----------------------------------------------- |
| `svg-bbox`        | Main entry point - shows all available commands |
| `sbb-getbbox`     | Compute bounding boxes from command line        |
| `sbb-extractor`   | Extract/export SVG objects with correct viewBox |
| `sbb-render`      | Render SVG to PNG with accurate bounds          |
| `sbb-fix-viewbox` | Repair missing/broken viewBox attributes        |
| `sbb-comparer`    | Visual diff between SVGs (pixel-by-pixel)       |

### 3. Inkscape Comparison Tools

Tools to compare our library's results against Inkscape's bbox algorithm:

| Tool                     | Purpose                          |
| ------------------------ | -------------------------------- |
| `sbb-inkscape-text2path` | Convert text to paths (Inkscape) |
| `sbb-inkscape-extract`   | Extract by ID (Inkscape)         |
| `sbb-inkscape-svg2png`   | SVG to PNG (Inkscape)            |

> **Note:** Inkscape tools are for **comparison only**. They have known font
> bbox issues. Use core tools for production.

---

## 📚 Table of Contents

- [The Problem with getBBox](#the-problem-with-getbbox)
- [Quick Start](#quick-start)
- [What This Package Provides](#what-this-package-provides)
- [Library API Reference](#-library-api-reference)
- [Installation](#-installation)
- [Browser Usage Examples](#-browser-usage-examples)
- [Node.js Usage Examples](#-nodejs-usage-examples)
- [CLI Tools Reference](#-cli-tools-reference)
- [How It Works](#-how-it-works)
- [Platform Compatibility](#platform-compatibility)
- [Troubleshooting](#-troubleshooting)
- [Contributing](#-contributing)
- [License](#-license)

---

## 📖 Library API Reference

The `SvgVisualBBox` library exposes these functions:

### `getSvgElementVisualBBoxTwoPassAggressive(target, options?)`

Compute a high-accuracy visual bounding box for any SVG element.

```javascript
const bbox = await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(
  '#myElement', // CSS selector, ID string, or DOM element
  {
    mode: 'unclipped', // 'clipped' (respect viewBox) or 'unclipped' (full drawing)
    coarseFactor: 3, // Coarse sampling resolution
    fineFactor: 24 // Fine sampling resolution
  }
);
// Returns: { x, y, width, height } in SVG user units
```

### `getSvgElementsUnionVisualBBox(targets[], options?)`

Compute the union bounding box of multiple elements.

```javascript
const union = await SvgVisualBBox.getSvgElementsUnionVisualBBox([
  '#text1',
  '#text2',
  document.getElementById('path3')
]);
```

### `getSvgElementVisibleAndFullBBoxes(target, options?)`

Get both the visible (clipped to viewBox) and full (entire drawing) bounds.

```javascript
const { visible, full } =
  await SvgVisualBBox.getSvgElementVisibleAndFullBBoxes('svg');
```

### `showTrueBBoxBorder(target, options?)`

Visual debugging helper - displays a border around the true visual bounds.

```javascript
const result = await SvgVisualBBox.showTrueBBoxBorder('#myText', {
  theme: 'dark', // 'light', 'dark', or 'auto'
  borderColor: 'red',
  borderWidth: '2px',
  padding: 5
});

// Later: remove the border
result.remove();
```

### `waitForDocumentFonts(document?, timeoutMs?)`

Wait for fonts to load before measuring text.

```javascript
await SvgVisualBBox.waitForDocumentFonts(document, 5000);
```

---

## 🔧 Programmatic Usage

### In HTML Page

```html
<!DOCTYPE html>
<html>
  <head>
    <script src="https://unpkg.com/svg-bbox@latest/SvgVisualBBox.min.js"></script>
  </head>
  <body>
    <svg id="mySvg" viewBox="0 0 200 100">
      <rect id="myRect" x="10" y="10" width="50" height="30" fill="blue" />
    </svg>

    <script>
      (async () => {
        // Get bounding box
        const bbox =
          await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(
            '#myRect'
          );
        console.log('BBox:', bbox);

        // Show debug border
        const border = await SvgVisualBBox.showTrueBBoxBorder('#myRect');
        setTimeout(() => border.remove(), 3000); // Remove after 3s
      })();
    </script>
  </body>
</html>
```

### In JavaScript/Node.js

```javascript
// Install: npm install svg-bbox puppeteer

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

async function getBBoxFromSVGFile(svgPath) {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  // Load SVG file
  const svgContent = fs.readFileSync(svgPath, 'utf-8');
  await page.setContent(`
    <!DOCTYPE html>
    <html><body>${svgContent}</body></html>
  `);

  // Inject SvgVisualBBox library
  const libPath = path.join(
    __dirname,
    'node_modules/svg-bbox/SvgVisualBBox.js'
  );
  await page.addScriptTag({ path: libPath });

  // Get bounding box
  const bbox = await page.evaluate(async () => {
    const svg = document.querySelector('svg');
    return await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(svg);
  });

  await browser.close();
  return bbox;
}

// Usage
getBBoxFromSVGFile('input.svg').then((bbox) => {
  console.log('BBox:', bbox);
});
```

### In TypeScript

```typescript
// Install: npm install svg-bbox puppeteer @types/puppeteer

import puppeteer from 'puppeteer';
import { readFileSync } from 'fs';
import { join } from 'path';

interface BBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function getBBoxFromSVGFile(svgPath: string): Promise<BBox | null> {
  const browser = await puppeteer.launch();
  const page = await browser.newPage();

  const svgContent = readFileSync(svgPath, 'utf-8');
  await page.setContent(`
    <!DOCTYPE html>
    <html><body>${svgContent}</body></html>
  `);

  const libPath = join(__dirname, 'node_modules/svg-bbox/SvgVisualBBox.js');
  await page.addScriptTag({ path: libPath });

  const bbox = await page.evaluate(async (): Promise<BBox | null> => {
    const svg = document.querySelector('svg');
    if (!svg) return null;
    return await (
      window as any
    ).SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(svg);
  });

  await browser.close();
  return bbox;
}

// Usage
getBBoxFromSVGFile('input.svg').then((bbox) => {
  console.log('BBox:', bbox);
});
```

### In Backend (Node.js File Processing)

```javascript
// Install: npm install svg-bbox

const { execFileSync } = require('child_process');
const path = require('path');

// Get path to CLI tool
const sbbGetBBox = path.join(__dirname, 'node_modules/.bin/sbb-getbbox');
const sbbRender = path.join(__dirname, 'node_modules/.bin/sbb-render');
const sbbFixer = path.join(__dirname, 'node_modules/.bin/sbb-fix-viewbox');

// Compute bounding box
function getBBox(svgFile) {
  const output = execFileSync(sbbGetBBox, [svgFile, '--json', 'bbox.json']);
  const result = JSON.parse(require('fs').readFileSync('bbox.json', 'utf-8'));
  return result[svgFile]['WHOLE CONTENT'];
}

// Fix viewBox
function fixViewBox(inputSvg, outputSvg) {
  execFileSync(sbbFixer, [inputSvg, outputSvg]);
}

// Render to PNG
function renderToPNG(svgFile, pngFile, width = 800) {
  execFileSync(sbbRender, [
    svgFile,
    pngFile,
    '--width',
    width.toString(),
    '--background',
    'transparent'
  ]);
}

// Usage
const bbox = getBBox('input.svg');
console.log('BBox:', bbox);

fixViewBox('broken.svg', 'fixed.svg');
renderToPNG('input.svg', 'output.png', 1200);
```

### Using CLI Tools Programmatically

```javascript
// All CLI tools can be used programmatically via child_process

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFilePromise = promisify(execFile);

// Example: Extract object
async function extractObject(inputSvg, objectId, outputSvg) {
  const { stdout, stderr } = await execFilePromise('sbb-extractor', [
    inputSvg,
    '--extract',
    objectId,
    outputSvg,
    '--margin',
    '10'
  ]);
  return { stdout, stderr };
}

// Example: Compare SVGs
async function compareSVGs(svg1, svg2) {
  const { stdout } = await execFilePromise('sbb-comparer', [
    svg1,
    svg2,
    '--json'
  ]);
  return JSON.parse(stdout);
}

// Usage
extractObject('sprites.svg', 'icon_home', 'home.svg').then(() =>
  console.log('Extracted!')
);

compareSVGs('v1.svg', 'v2.svg').then((result) =>
  console.log('Difference:', result.diffPercentage + '%')
);
```

---

## 💡 Features

- **Sprite sheet detection & processing** Automatically detects SVGs used as
  icon/sprite stacks and provides batch processing capabilities.

- **Font-aware text bounds** Works with complex scripts (Arabic, CJK, Tamil),
  ligatures, RTL/LTR, `textPath`, `tspan`, and more.

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
  Extract a single object or export all objects/groups as standalone SVGs, each
  sized exactly to its visual bounds.

---

## 📦 Installation

### Quick Install (npx - No Installation Required!)

You can run any svg-bbox tool directly without installing:

```bash
# See all available commands
npx svg-bbox

# Run specific tools
npx sbb-getbbox myfile.svg
npx sbb-render myfile.svg output.png
npx sbb-extractor myfile.svg --list
```

### Global Install (Recommended for Frequent Use)

```bash
# npm
npm install -g svg-bbox

# pnpm
pnpm add -g svg-bbox

# yarn
yarn global add svg-bbox

# After global install, run commands directly:
svg-bbox              # Show all available commands
sbb-getbbox file.svg  # Compute bounding box
sbb-render file.svg output.png
```

### Local Install (For Projects)

```bash
# npm
npm install svg-bbox

# pnpm
pnpm add svg-bbox

# yarn
yarn add svg-bbox

# Then use via npx or package.json scripts:
npx sbb-getbbox file.svg
```

### Via CDN (Browser - No Build Tools Required!)

For direct browser usage, use the minified UMD build from a CDN:

```html
<!-- Via unpkg (Recommended) -->
<script src="https://unpkg.com/svg-bbox@latest/SvgVisualBBox.min.js"></script>

<!-- Via jsdelivr -->
<script src="https://cdn.jsdelivr.net/npm/svg-bbox@latest/SvgVisualBBox.min.js"></script>

<!-- Then use the global SvgVisualBBox object -->
<script>
  (async () => {
    // Wait for fonts to load
    await SvgVisualBBox.waitForDocumentFonts(document, 5000);

    // Get bbox for an SVG element
    const bbox =
      await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive('my-svg-id');
    console.log('BBox:', bbox);
  })();
</script>
```

**File sizes:**

- Original: ~90 KB
- Minified (CDN): ~25 KB _(72% reduction)_

### Clone from GitHub

```bash
git clone https://github.com/Emasoft/SVG-BBOX.git
cd SVG-BBOX
pnpm install

# Run tools directly from source
node sbb-getbbox.cjs myfile.svg
```

> **Note:** In the documentation below, you'll see two command styles:
>
> - `npx sbb-getbbox` - Use this when installed via npm (recommended)
> - `node sbb-getbbox.cjs` - Use this when running from cloned source
>
> Both are equivalent. The npx style works after `npm install svg-bbox`.

After installation, the following CLI commands are available:

**Main Entry Point:**

- `svg-bbox` - **Start here!** Shows help and lists all available commands

**Core Tools (Recommended):**

- `sbb-getbbox` - Compute visual bounding boxes
- `sbb-extractor` - List, extract, and export SVG objects
- `sbb-fix-viewbox` - Fix missing viewBox/dimensions
- `sbb-render` - Render SVG to PNG
- `sbb-comparer` - Compare two SVGs visually (pixel-by-pixel)
- `sbb-test` - Test library functions

**Inkscape Integration Tools** ⚠️ _(For comparison only - see warnings below)_:

- `sbb-inkscape-text2path` - Convert text to paths using Inkscape
- `sbb-inkscape-extract` - Extract objects by ID using Inkscape
- `sbb-inkscape-svg2png` - SVG to PNG export using Inkscape

> **⚠️ Accuracy Warning:** Inkscape tools have known issues with font bounding
> boxes. Use core tools for production. Inkscape tools are for comparison
> purposes only.

### From Source

```bash
git clone https://github.com/Emasoft/SVG-BBOX.git
cd svg-bbox
pnpm install
```

### Requirements

> **CRITICAL**: You need **Node.js ≥ 18** and **Chrome or Chromium** installed.
>
> **⚠️ ONLY Chrome/Chromium are supported** — other browsers have poor SVG
> support. This library uses headless Chrome via Puppeteer for measurements, and
> visual verification must use the same browser engine to match results.

After installing, Puppeteer will automatically download a compatible Chromium
browser. Alternatively, you can use your system Chrome by setting the
`PUPPETEER_EXECUTABLE_PATH` environment variable.

### Platform Compatibility

✅ **Fully cross-platform compatible:**

- **Windows** 10/11 - All CLI tools work natively (PowerShell, CMD, Git Bash)
- **macOS** - All versions supported (Intel and Apple Silicon)
- **Linux** - All major distributions (Ubuntu, Debian, Fedora, etc.)

**Key features:**

- All file paths use Node.js `path` module (no hardcoded `/` or `\` separators)
- Platform-specific commands handled automatically (Chrome detection, file
  opening)
- Works with file paths containing spaces on all platforms
- Pure Node.js CLI tools (no bash scripts required)

**Platform-specific notes:**

<details>
<summary><strong>Windows</strong></summary>

- Chrome/Chromium auto-detection works with default install locations
- File paths with spaces are properly handled
- Use PowerShell or CMD (no WSL required)
- Git Bash also supported

```powershell
# PowerShell example
sbb-getbbox "C:\My Files\drawing.svg"
```

</details>

<details>
<summary><strong>macOS</strong></summary>

- Detects Chrome in `/Applications/`
- Uses native `open` command for file viewing
- Works on both Intel and Apple Silicon Macs

```bash
# macOS example
chmod +x node_modules/.bin/sbb-*  # Make executable (first time only)
sbb-getbbox ~/Documents/drawing.svg
```

</details>

<details>
<summary><strong>Linux</strong></summary>

- Auto-detects `google-chrome`, `chromium`, `chromium-browser`
- All standard Linux file paths supported

```bash
# Linux example
chmod +x node_modules/.bin/sbb-*  # Make executable (first time only)
sbb-getbbox /home/user/drawings/test.svg
```

</details>

---

## 🚀 Quickstart

### 1. See All Available Commands

```bash
npx svg-bbox
```

This displays help with all available tools and usage examples.

---

### 2. Render an SVG to PNG at the correct size

```bash
npx sbb-render input.svg output.png --mode full --scale 4
```

- Detects the **full drawing extents**.
- Sets an appropriate `viewBox`.
- Renders to PNG at 4 px per SVG unit.

---

### 3. Fix an SVG that has no `viewBox` / `width` / `height`

```bash
npx sbb-fix-viewbox broken.svg fixed/broken.fixed.svg
```

- Computes the **full visual drawing box**.
- Writes a new SVG with:
  - `viewBox="x y width height"`
  - Consistent `width` / `height`.

---

### 4. List all objects visually & generate a rename JSON

```bash
npx sbb-extractor sprites.svg --list --assign-ids --out-fixed sprites.ids.svg
```

This produces:

- `sprites.objects.html` — a visual catalog.
- `sprites.ids.svg` — a version where all objects have IDs like
  `auto_id_path_3`.

Open `sprites.objects.html` in a browser to see previews and define new ID
names.

---

### 5. Extract one object as its own SVG

```bash
npx sbb-extractor sprites.renamed.svg \
  --extract icon_save icon_save.svg \
  --margin 5
```

This creates `icon_save.svg` sized exactly to the **visual bounds** of
`#icon_save` (with 5 units of padding).

---

### 6. Export all objects as individual SVGs

```bash
npx sbb-extractor sprites.renamed.svg \
  --export-all exported \
  --export-groups \
  --margin 2
```

Each object / group becomes its own SVG, with:

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

The **key idea** is to let the browser do all layout and rendering, then sample
the output to deduce where pixels actually appear. This makes bounding boxes
robust to:

- Fonts
- Filters
- Transforms
- `<use>` shadow DOM
- Mixed units and crazy coordinate systems

---

## 🛠 Tools

### Library: `SvgVisualBBox.js`

This library can be used in two ways:

1. **Node.js/CLI Tools** - Injected by Puppeteer in headless Chrome (used by all
   CLI tools)
2. **Browser/Web Applications** - Loaded directly in webpages via `<script>` tag
   or npm import

The library exposes all functions through the `SvgVisualBBox` namespace.

#### `waitForDocumentFonts(document, timeoutMs)`

Waits for fonts to be ready (or a timeout) before measuring text.

```js
await SvgVisualBBox.waitForDocumentFonts(document, 8000);
```

#### `getSvgElementVisualBBoxTwoPassAggressive(element, options)`

Compute a **visual** bounding box for an element (including stroke, filters,
etc.):

```js
const bbox = await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(
  element,
  {
    mode: 'unclipped', // ignore viewBox clipping when measuring
    coarseFactor: 3, // coarse sampling
    fineFactor: 24, // fine sampling
    useLayoutScale: true // scale based on layout size
  }
);

// bbox: { x, y, width, height } in SVG user units
```

#### `getSvgElementVisibleAndFullBBoxes(svgElement, options)`

Compute both:

- **visible** – what’s inside the current viewBox.
- **full** – the entire drawing, ignoring viewBox clipping.

Used by the fixer and renderer to choose between "full drawing" and "visible
area inside the viewBox".

#### `showTrueBBoxBorder(target, options)` ⭐ NEW

**Visual debug helper** - Displays a dotted border overlay around any SVG
element's true visual bounding box.

```js
// Show border with auto-detected theme
const result = await SvgVisualBBox.showTrueBBoxBorder('#myText');

// Force dark theme for light backgrounds
const result = await SvgVisualBBox.showTrueBBoxBorder('#myPath', {
  theme: 'dark'
});

// Custom styling
const result = await SvgVisualBBox.showTrueBBoxBorder('#myElement', {
  borderColor: 'red',
  borderWidth: '3px',
  padding: 10
});

// Remove border
result.remove();
```

**Features:**

- ✅ Auto-detects system dark/light theme
- ✅ Force theme with `theme: 'light'` or `'dark'` option
- ✅ Works with all SVG types (inline, `<object>`, `<iframe>`, sprites, dynamic)
- ✅ Non-intrusive overlay (doesn't modify SVG)
- ✅ Follows SVG on scroll/resize
- ✅ Easy cleanup with `remove()`

---

### 🌐 Browser Usage

You can use `SvgVisualBBox.js` directly in webpages for accurate bounding box
computation and visual debugging.

#### Installation

```html
<!-- CDN -->
<script src="https://unpkg.com/svg-bbox@latest/SvgVisualBBox.js"></script>

<!-- Or via npm -->
<script src="./node_modules/svg-bbox/SvgVisualBBox.js"></script>
```

#### Quick Example

```html
<!DOCTYPE html>
<html>
  <head>
    <script src="https://unpkg.com/svg-bbox@latest/SvgVisualBBox.js"></script>
  </head>
  <body>
    <svg viewBox="0 0 200 100" width="400">
      <text id="greeting" x="100" y="50" text-anchor="middle" font-size="24">
        Hello SVG!
      </text>
    </svg>

    <script>
      (async () => {
        // Wait for fonts
        await SvgVisualBBox.waitForDocumentFonts();

        // Get accurate bounding box
        const bbox =
          await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(
            '#greeting'
          );
        console.log('BBox:', bbox); // {x, y, width, height}

        // Show visual border for debugging
        const result = await SvgVisualBBox.showTrueBBoxBorder('#greeting');

        // Reframe viewBox to focus on element
        await SvgVisualBBox.setViewBoxOnObjects('svg', 'greeting', {
          aspect: 'stretch',
          margin: '10px'
        });

        // Remove border after 3 seconds
        setTimeout(() => result.remove(), 3000);
      })();
    </script>
  </body>
</html>
```

#### Complete API Documentation

See [API.md](./API.md) for comprehensive browser API documentation with examples
for:

- Computing accurate bounding boxes
- Working with complex text and transforms
- Handling multiple elements
- Visual debugging with borders
- Reframing viewBox to focus on objects
- Theme customization
- Error handling
- Performance tips

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
  - Measure it visually and render a canvas just big enough for that element (+
    margin).

#### Example

```bash
# Transparent PNG of what's actually visible in the viewBox
node sbb-render.cjs map.svg map.png \
  --mode visible \
  --margin 10 \
  --background transparent
```

---

### Comparer: `sbb-comparer.cjs`

Compare two SVGs visually by rendering them to PNG and performing pixel-by-pixel
comparison.

#### Syntax

```bash
node sbb-comparer.cjs svg1.svg svg2.svg [options]
```

#### Options

- `--out-diff <file>` - Output diff PNG file (white=different, black=same)
- `--threshold <1-20>` - Pixel difference threshold (default: 1)
  - Pixels differ if any RGBA channel differs by more than threshold/256
- `--alignment <mode>` - How to align the two SVGs
  - `origin` - Align using respective SVG origins (0,0) [default]
  - `viewbox-topleft` - Align using top-left corners of viewBox
  - `viewbox-center` - Align using centers of viewBox
  - `object:<id>` - Align using coordinates of specified object ID
  - `custom:<x>,<y>` - Align using custom coordinates
- `--resolution <mode>` - How to determine render resolution
  - `viewbox` - Use respective viewBox dimensions [default]
  - `nominal` - Use respective nominal resolutions
  - `full` - Use full drawing content (ignore viewBox)
  - `scale` - Scale to match larger SVG (uniform)
  - `stretch` - Stretch to match larger SVG (non-uniform)
  - `clip` - Clip to match smaller SVG
- `--meet-rule <rule>` - Aspect ratio rule for 'scale' mode (default: xMidYMid)
- `--slice-rule <rule>` - Aspect ratio rule for 'clip' mode (default: xMidYMid)
- `--json` - Output results as JSON
- `--verbose` - Show detailed progress

#### Examples

```bash
# Basic comparison
node sbb-comparer.cjs original.svg modified.svg

# Compare with custom threshold (more tolerant)
node sbb-comparer.cjs v1.svg v2.svg --threshold 5 --out-diff changes.png

# Align by viewBox centers, scale to match
node sbb-comparer.cjs icon1.svg icon2.svg \
  --alignment viewbox-center \
  --resolution scale

# JSON output for automation
node sbb-comparer.cjs test1.svg test2.svg --json
```

#### Output

Returns:

- Difference percentage (0-100%)
- Total pixels compared
- Number of different pixels
- Diff PNG image (white pixels = different, black = identical)
- **HTML comparison report** (automatically generated and opened in browser)
  - Side-by-side SVG comparison with embedded images
  - ViewBox and resolution details for each SVG
  - Comparison settings summary
  - Visual diff PNG with percentage
  - Self-contained (can be shared without dependencies)

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
- **Full drawing mode**: Use `--ignore-vbox` to measure complete drawing
  (ignoring viewBox clipping)
- **Sprite sheet detection**: Use `--sprite` to automatically detect and process
  icon sprites/stacks
- **Batch processing**: Process entire directories with optional regex filter
- **List files**: Process multiple SVGs with per-file object IDs from a text
  file
- **JSON export**: Save results as JSON for programmatic use
- **Auto-repair**: Missing SVG attributes (viewBox, width, height,
  preserveAspectRatio) are computed

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

When using the `--sprite` flag with no object IDs specified, the tool
automatically detects sprite sheets (SVGs used as icon stacks) and processes
each sprite/icon separately.

**Detection criteria:**

- **Size uniformity** - Coefficient of variation < 0.3 for widths, heights, or
  areas
- **Grid arrangement** - Icons arranged in rows/columns with consistent spacing
- **Common naming patterns** - IDs matching `icon_`, `sprite_`, `symbol_`,
  `glyph_`, or numeric patterns
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
    "WHOLE CONTENT": { "x": 0, "y": 0, "width": 100, "height": 100 },
    "icon1": { "x": 10, "y": 10, "width": 20, "height": 20 },
    "icon2": { "x": 50, "y": 50, "width": 30, "height": 30 }
  }
}
```

---

### Multi-tool: `sbb-extractor.cjs`

A versatile tool for **listing, renaming, extracting, and exporting** SVG
objects.

#### 1️⃣ List mode — `--list`

```bash
node sbb-extractor.cjs input.svg --list \
  [--assign-ids --out-fixed fixed.svg] \
  [--out-html list.html] \
  [--json]
```

**What it does:**

- Scans the SVG for "objects":
  - `g`, `path`, `rect`, `circle`, `ellipse`,
  - `polygon`, `polyline`, `text`, `image`, `use`, `symbol`.
- **Automatically detects sprite sheets** - identifies SVGs used as icon/sprite
  stacks and provides helpful tips.
- Computes a **visual bbox** for each object.
- Generates an **HTML page**:
  - Column `#`: row number (used in warnings).
  - Column `OBJECT ID`: current `id` (empty if none).
  - Column `Tag`: element name.
  - Column `Preview`: small `<svg>` using the object’s bbox and
    `<use href="#id">`.
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
node sbb-extractor.cjs input.svg --rename mapping.json output.svg [--json]
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
    - Updates `url(#from)` → `url(#to)` in all attributes (fills, filters,
      masks, etc.).
  - Invalid mappings are **skipped** and reported (reason included).

#### 3️⃣ Extract mode — `--extract`

Extract a **single object** into its own SVG.

```bash
node sbb-extractor.cjs input.svg --extract someId output.svg \
  [--margin N] \
  [--include-context] \
  [--json]
```

Two modes:

- **Default (no `--include-context`)** → _pure cut-out_:
  - Keeps only:
    - Target element.
    - Its ancestor groups.
    - `<defs>` (for filters, markers, etc.).
  - No siblings or overlays.

- **With `--include-context`** → _cut-out with context_:
  - Copies all children of the root `<svg>` (so overlays & backgrounds stay).
  - Crops the root `viewBox` to the target object’s bbox (+ margin).
  - Good when you want to see the object under the same filters/overlays but
    cropped to its own rectangle.

#### 4️⃣ Export-all mode — `--export-all`

Export every object (and optionally groups) as separate SVGs.

```bash
node sbb-extractor.cjs input.svg --export-all out-dir \
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
- Includes the ancestor chain from the root to the object, with the object’s
  full subtree.

---

### Inkscape Integration Tools: `sbb-inkscape-*` ⚠️

**⚠️ IMPORTANT ACCURACY WARNING**

The Inkscape-based tools (`sbb-inkscape-*`) are provided **for completeness and
comparison purposes only**. They use Inkscape's rendering engine which has
**known issues with font bounding box calculations** and may produce inaccurate
results, especially for text elements.

**For production use and accurate bounding box computation, always use the
native svg-bbox tools:**

- `sbb-render.cjs` - Native SVG rendering with accurate bbox
- `sbb-getbbox.cjs` - Precise bounding box calculation
- `sbb-extractor.cjs` - Multi-tool with accurate visual bbox

These native tools use our custom algorithms that correctly handle font metrics
and provide reliable, cross-platform results.

---

#### Available Inkscape Tools

##### 1. `sbb-inkscape-text2path.cjs` - Convert Text to Paths

Convert text elements to path outlines using Inkscape.

```bash
node sbb-inkscape-text2path.cjs input.svg [options]
```

**Options:**

- `--output <file>` - Output SVG file (default: `<input>-paths.svg`)
- `--batch <file>` - Batch mode (one SVG path per line)
- `--overwrite` - Overwrite output file if it exists
- `--skip-comparison` - Skip automatic similarity check (faster)
- `--json` - Output results as JSON
- `--help` - Show help
- `--version` - Show version

**Example:**

```bash
# Convert text to paths
node sbb-inkscape-text2path.cjs document.svg

# Convert with custom output
node sbb-inkscape-text2path.cjs document.svg document-paths.svg

# Batch convert multiple files
node sbb-inkscape-text2path.cjs --batch files.txt

# Skip automatic comparison (faster)
node sbb-inkscape-text2path.cjs document.svg --skip-comparison

# Overwrite existing files
node sbb-inkscape-text2path.cjs document.svg --overwrite
```

##### 2. `sbb-inkscape-extract.cjs` - Extract Object by ID

Extract a single object from an SVG file by its ID.

```bash
node sbb-inkscape-extract.cjs input.svg --id <object-id> [options]
```

**Options:**

- `--id <id>` - Object ID to extract (required)
- `--output <file>` - Output SVG file (default: `<input>_<id>.svg`)
- `--margin <pixels>` - Margin around extracted object in pixels
- `--help` - Show help
- `--version` - Show version

**Example:**

```bash
# Extract specific object
node sbb-inkscape-extract.cjs sprite.svg --id icon_home

# Extract with custom output
node sbb-inkscape-extract.cjs sprite.svg --id icon_home --output home.svg

# Extract with margin
node sbb-inkscape-extract.cjs sprite.svg --id icon_home --margin 10
```

⚠️ **Note:** For more reliable object extraction with accurate bounding boxes,
use `sbb-extractor.cjs --extract` instead.

##### 3. `sbb-inkscape-svg2png.cjs` - SVG to PNG Export

Comprehensive PNG export with full control over all Inkscape parameters.

```bash
node sbb-inkscape-svg2png.cjs input.svg [options]
```

**Dimension & Resolution Options:**

- `--width <pixels>`, `--height <pixels>` - Export dimensions
- `--dpi <dpi>` - Export DPI (default: 96)
- `--margin <pixels>` - Margin around export area

**Export Area Options:**

- `--area-drawing` - Bounding box of all objects (default)
- `--area-page` - Full SVG page/viewBox area
- `--area-snap` - Snap to nearest integer px (pixel-perfect)
- `--id <object-id>` - Export specific object by ID

**Color & Quality Options:**

- `--color-mode <mode>` - Gray_1-16, RGB_8-16, GrayAlpha_8-16, RGBA_8-16
- `--compression <0-9>` - PNG compression level (default: 6)
- `--antialias <0-3>` - Antialiasing level (default: 2)

**Background Options:**

- `--background <color>` - Background color (SVG color string)
- `--background-opacity <n>` - Opacity: 0.0-1.0 or 1-255

**Legacy File Handling:**

- `--convert-dpi <method>` - none/scale-viewbox/scale-document

**Batch Processing:**

- `--batch <file>` - Process multiple files (one SVG path per line)

**Other Options:**

- `--help` - Show help
- `--version` - Show version

**Examples:**

```bash
# High-quality export with maximum compression
node sbb-inkscape-svg2png.cjs logo.svg \
  --width 1024 --height 1024 \
  --antialias 3 --compression 9

# Export with white background
node sbb-inkscape-svg2png.cjs document.svg \
  --area-page \
  --background white --background-opacity 1.0

# Grayscale export
node sbb-inkscape-svg2png.cjs drawing.svg --color-mode Gray_8

# Pixel-perfect export
node sbb-inkscape-svg2png.cjs pixel-art.svg --area-snap --dpi 96

# Batch export with shared settings
node sbb-inkscape-svg2png.cjs --batch icons.txt \
  --width 256 --height 256 --compression 9
```

⚠️ **Note:** For production use, prefer `sbb-render.cjs` for accurate font
rendering and bounding boxes.

---

#### Why Use Native Tools Instead?

| Feature                | Inkscape Tools (`sbb-inkscape-*`) | Native Tools (`sbb-*`)   |
| ---------------------- | --------------------------------- | ------------------------ |
| **Font bbox accuracy** | ❌ Known issues, often incorrect  | ✅ Accurate calculations |
| **Text rendering**     | ⚠️ Can vary by system             | ✅ Consistent results    |
| **Cross-platform**     | ⚠️ Requires Inkscape install      | ✅ Works everywhere      |
| **Performance**        | ⚠️ Slower (external process)      | ✅ Fast (native)         |
| **Best for**           | Testing/comparison                | Production use           |

**Recommendation:** Use `sbb-inkscape-*` tools only when you need to:

- Compare results with Inkscape's output
- Test compatibility with Inkscape workflows
- Convert text to paths (no native alternative yet)

For all other use cases, especially involving text or requiring accurate
bounding boxes, **always use the native `sbb-*` tools**.

---

## 🧭 Renaming workflow with the HTML viewer

A typical end‑to‑end workflow:

1. **Analyze the SVG & give everything an ID**

   ```bash
   node sbb-extractor.cjs sprites.svg \
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
   - In “New ID name”, type meaningful names (`icon_save`, `logo_main`,
     `button_primary`, …).
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
   node sbb-extractor.cjs sprites.ids.svg \
     --rename sprites.rename.json \
     sprites.renamed.svg
   ```

6. **Extract or export with stable IDs**

   ```bash
   # One object
   node sbb-extractor.cjs sprites.renamed.svg \
     --extract icon_save icon_save.svg --margin 5

   # All objects
   node sbb-extractor.cjs sprites.renamed.svg \
     --export-all exported --export-groups --margin 2
   ```

---

## 🛟 Troubleshooting

### 💥 Puppeteer / browser fails to launch

- Make sure **Chrome** or **Chromium** is installed.
- If Puppeteer can't find a browser:
  - Try installing the default Chromium:
    `npx puppeteer browsers install chrome`.
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

If Chrome/Chromium is not found, you'll see an error message with installation
instructions.

**CRITICAL**: Other browsers have poor SVG support. This library uses headless
Chrome for measurements, so visual verification must use the same browser
engine.

### 🖋 Fonts look wrong / text bbox is off

- The headless browser must be able to load the fonts:
  - If you use web fonts (`@font-face`), check that the URLs are reachable.
  - If you rely on system fonts, install them on the machine running the
    scripts.
- For maximum accuracy, the tools call `SvgVisualBBox.waitForDocumentFonts`
  before sampling; still, flaky font hosting can cause issues.

### 🖼 External images not showing

- `<image>` `href`/`xlink:href` URLs must be reachable from the headless
  browser.
- Local file URLs might need adjustments (`file://` vs relative paths).
- Some environments may block remote HTTP requests (e.g., firewalls, CI
  restrictions).

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
- Remember that **filters** and **strokes** can extend far beyond the underlying
  path.

---

## 🤝 Contributing

PRs, issues, and ideas are welcome!

- Found an SVG that breaks the visual bbox heuristics?
- Have a nasty filter / font combo that behaves oddly?
- Want a new CLI mode or integration?

Open an issue with a **minimal test SVG** and a short description of what you
expected vs what you saw.

---

## 📄 License

This project is licensed under the **MIT License**.

You’re free to:

- Use it in commercial and non-commercial projects.
- Modify and distribute it.
- Fork it and build your own specialized tooling.

See the \`LICENSE\` file for full details.
