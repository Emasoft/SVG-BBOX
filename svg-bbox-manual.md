
# SvgVisualBBox Manual

A high‑accuracy **visual bounding box** toolkit for SVG, using a robust two‑pass
rasterization approach and a Puppeteer‑based Node.js test harness.

---

## Table of Contents

1. [Overview](#overview)  
2. [Files & Layout](#files--layout)  
3. [Requirements](#requirements)  
4. [Using the Library in the Browser](#using-the-library-in-the-browser)  
   - [Inline SVG](#inline-svg)  
   - [External SVG via `<object>`](#external-svg-via-object)  
5. [Core Concepts](#core-concepts)  
   - [Coordinate System](#coordinate-system)  
   - [Clipped vs Unclipped](#clipped-vs-unclipped)  
   - [Two‑Pass Rasterization](#two-pass-rasterization)  
6. [API Reference](#api-reference)  
   - [`waitForDocumentFonts`](#waitfordocumentfontsdoc-timeoutms)  
   - [`getSvgElementVisualBBoxTwoPassAggressive`](#getsvgelementvisualbboxtwopassaggressivetarget-options)  
   - [`getSvgElementsUnionVisualBBox`](#getsvgelementsunionvisualbboxtargets-options)  
   - [`getSvgElementVisibleAndFullBBoxes`](#getsvgelementvisibleandfullbboxestarget-options)  
   - [`getSvgRootViewBoxExpansionForFullDrawing`](#getsvgrootviewboxexpansionforfulldrawingsvgrootorid-options)  
7. [Node.js Test Harness](#nodejs-test-harness)  
   - [Setup](#setup)  
   - [Running Tests](#running-tests)  
   - [Understanding the Output](#understanding-the-output)  
8. [Common Workflows & Examples](#common-workflows--examples)  
   - [Checking if Text Fits a Shape](#checking-if-text-fits-a-shape)  
   - [Comparing Visible vs Hidden Content](#comparing-visible-vs-hidden-content)  
9. [Limitations & Notes](#limitations--notes)

---

## 1. Overview

The **SvgVisualBBox** library is built for situations where the standard
SVG geometry APIs (like `getBBox()`) are not reliable enough:

- Complex text: CJK, Arabic, Tamil, ligatures, RTL/LTR mixing, `text-anchor`, `tspan`, `textPath`, etc.
- Heavy use of `<use>`, `<symbol>`, `<defs>`, gradients, patterns.
- Strokes, joins, caps, markers, vector effects.
- Filters, masks, clip paths, compositing, bitmap images.
- SVGs with tricky `viewBox` / `preserveAspectRatio` / transforms.

Instead of using geometry only, the library:

1. **Clones** the root `<svg>`, isolating the target element while keeping all `<defs>` alive.
2. **Rasterizes** the SVG to an offscreen `<canvas>` at a high resolution.
3. **Scans pixels** to find non‑transparent pixels (alpha ≠ 0).
4. Converts the pixel bounds back into **SVG user units** (the root `<svg>`’s viewBox space).

Because we measure **what is actually drawn**, all visual effects are naturally
included in the bounding box: stroke, filters, masks, markers, images, patterns, etc.

---

## 2. Files & Layout

| File                  | Description                                                                                 |
|-----------------------|---------------------------------------------------------------------------------------------|
| `SvgVisualBBox.js`    | Main library (UMD): exposes `SvgVisualBBox` global in browser and works with CommonJS/AMD. |
| `sbb-test.cjs`    | Node.js CLI script that uses Puppeteer to test the library against a given SVG file.       |
| `manual.md`           | This manual – usage, API, and examples.                                                     |

Typical project layout:

```text
your-project/
  SvgVisualBBox.js
  sbb-test.cjs
  manual.md
  some-drawing.svg
  package.json
```

---

## 3. Requirements

### Browser

- Modern browser with support for:
  - SVG rendering
  - `<canvas>` and `CanvasRenderingContext2D`
  - `Blob` / `URL.createObjectURL`
  - `DOMParser`
  - CSS Font Loading API (`document.fonts`) – optional but recommended for stable text layout

If the CSS Font Loading API is missing, `waitForDocumentFonts` becomes a no‑op and text
metrics may shift slightly as fonts load.

### Node.js Test Harness

Install Node dependencies:

```bash
npm install puppeteer chrome-launcher
```

| Dependency      | Purpose                                                                |
|----------------|-------------------------------------------------------------------------|
| `puppeteer`    | Controls headless Chrome/Chromium for rasterization and measurement.   |
| `chrome-launcher` | Finds system Chrome/Chromium when the bundled Chromium is unavailable. |

---

## 4. Using the Library in the Browser

Include the script as a normal `<script>`:

```html
<script src="SvgVisualBBox.js"></script>
```

It will define a global namespace:

```js
window.SvgVisualBBox
```

### Inline SVG

```html
<svg id="iconSvg" viewBox="0 0 100 100">
  <text id="label" x="10" y="50">Hello SVG</text>
</svg>

<script src="SvgVisualBBox.js"></script>
<script>
  (async () => {
    const bbox = await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive('label', {
      mode: 'clipped',     // measure visible bbox inside the viewBox
      coarseFactor: 3,
      fineFactor: 24
    });

    console.log('Text bbox in SVG units:', bbox);
  })();
</script>
```

### External SVG via `<object>`

```html
<object id="logoObj" data="logo.svg" type="image/svg+xml"></object>
<script src="SvgVisualBBox.js"></script>
<script>
  document.getElementById('logoObj').addEventListener('load', async function () {
    const svgDoc = this.contentDocument;        // inner SVG document
    const svgRoot = svgDoc.documentElement;     // <svg> root
    const label   = svgDoc.getElementById('label');

    const bbox = await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(label, {
      mode: 'clipped',
      coarseFactor: 3,
      fineFactor: 24
    });

    console.log('Label bbox in inner SVG units:', bbox);
  });
</script>
```

> ⚠️ DOM access to an external SVG only works when it’s **same‑origin** or CORS‑enabled.

---

## 5. Core Concepts

### Coordinate System

All bounding boxes are returned in the **user coordinate system of the root `<svg>`**:

- If the `<svg>` has a `viewBox="minX minY width height"`, that defines the coordinate system.
- If not, the library uses an arbitrary large coordinate extent as a fallback.

This means the returned `x`, `y`, `width`, `height` are directly comparable with:

- path segment coordinates
- `rect` / `circle` / `line` attributes
- any other SVG internal coordinates

### Clipped vs Unclipped

Many functions accept a `mode` option:

| Mode         | Meaning                                                                                     |
|--------------|---------------------------------------------------------------------------------------------|
| `"clipped"`  | Only the part of the element **inside the root viewBox/viewport** is considered.           |
| `"unclipped"`| Uses the full geometry bbox of the root SVG as ROI, effectively ignoring viewBox clipping. |

Both modes still use the same internal coordinate system; “unclipped” just changes the
region that is rasterized.

### Two‑Pass Rasterization

The “aggressive” bounding box function works in two passes:

1. **Pass 1 (coarse):**  
   - Large ROI (viewBox or full geometry) at lower resolution.  
   - Finds a rough bounding box of visible pixels.

2. **Pass 2 (fine):**  
   - ROI = coarse bbox expanded by a large safety margin in user units.  
   - High‑resolution rasterization + pixel scan → tight visual bbox.

This approach is robust against long‑range filter effects, masks, and strokes while
still giving high precision.

---

## 6. API Reference

All functions live under the `SvgVisualBBox` namespace.

### `waitForDocumentFonts(doc?, timeoutMs?)`

Waits for web fonts to load using the CSS Font Loading API (`document.fonts.ready`),
with an optional timeout.

```js
await SvgVisualBBox.waitForDocumentFonts(document, 8000);
```

| Parameter    | Type       | Default   | Description                                           |
|-------------|------------|-----------|-------------------------------------------------------|
| `doc`       | `Document` | `document`| Document whose fonts should be awaited.              |
| `timeoutMs` | `number`   | `8000`    | Max wait time in ms; if ≤ 0, waits without timeout.  |

**Returns:** `Promise<void>`

If the API isn’t supported in the current environment, the function returns immediately.

---

### `getSvgElementVisualBBoxTwoPassAggressive(target, options?)`

High‑accuracy **visual bounding box** of a single SVG element using a two‑pass rasterization.

```js
const bbox = await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive('myElementId', {
  mode: 'clipped',
  coarseFactor: 3,
  fineFactor: 24,
  safetyMarginUser: null,
  useLayoutScale: true,
  fontTimeoutMs: 8000
});
```

#### Parameters

| Option              | Type                    | Default      | Description                                                                                         |
|---------------------|-------------------------|--------------|-----------------------------------------------------------------------------------------------------|
| `target`            | `Element` \| `string`   | —            | The SVG element or its `id`. Must be contained in some `<svg>`.                                     |
| `mode`              | `"clipped"` \| `"unclipped"` | `"clipped"` | `"clipped"` → only inside viewBox; `"unclipped"` → whole drawing region.                            |
| `coarseFactor`      | `number`                | `3`          | Multiplier for base px/unit in pass 1.                                                              |
| `fineFactor`        | `number`                | `24`         | Multiplier for base px/unit in pass 2 (higher = more precise).                                      |
| `safetyMarginUser`  | `number` \| `null`      | `null`       | Extra margin in user units around pass‑1 bbox; if `null`, a generous default is used.               |
| `useLayoutScale`    | `boolean`               | `true`       | If true, base px/unit is derived from `getBoundingClientRect()` + viewBox, useful for non‑scaling strokes. |
| `fontTimeoutMs`     | `number`                | `8000`       | Max time (ms) to wait for fonts before measuring.                                                   |

#### Return Value

`Promise<{
  x: number,
  y: number,
  width: number,
  height: number,
  element: SVGElement,
  svgRoot: SVGSVGElement
} | null>`

- Returns `null` if the element is fully invisible (clipped/masked/transparent).

---

### `getSvgElementsUnionVisualBBox(targets, options?)`

Union of visual bounding boxes for multiple elements in the **same** root `<svg>`.

```js
const union = await SvgVisualBBox.getSvgElementsUnionVisualBBox(
  ['label1', 'label2', somePathElement],
  { mode: 'clipped' }
);
```

#### Parameters

| Parameter | Type                         | Description                                                  |
|----------|------------------------------|--------------------------------------------------------------|
| `targets`| `Array<Element \| string>`   | Elements or ids to measure. All must share the same root `<svg>`. |
| `options`| `object`                     | Forwarded to `getSvgElementVisualBBoxTwoPassAggressive`.     |

#### Return Value

`Promise<{
  x: number,
  y: number,
  width: number,
  height: number,
  svgRoot: SVGSVGElement,
  bboxes: Array<{
    x:number,y:number,width:number,height:number,
    element:SVGElement,svgRoot:SVGSVGElement
  }>
} | null>`

- `null` if all targets are invisible.  
- `bboxes` contains individual results for each visible target.

---

### `getSvgElementVisibleAndFullBBoxes(target, options?)`

Convenience helper that returns **both**:

- a bbox **inside the viewBox** (`mode: "clipped"`), and  
- a bbox for the **full drawing region** (`mode: "unclipped"`).

```js
const { visible, full } =
  await SvgVisualBBox.getSvgElementVisibleAndFullBBoxes('mySvgOrElement', {
    coarseFactor: 3,
    fineFactor: 24
  });
```

#### Parameters

| Parameter | Type                       | Description                                                    |
|----------|----------------------------|----------------------------------------------------------------|
| `target` | `Element` \| `string`      | Element or id inside an `<svg>` (including the root `<svg>`). |
| `options`| `object`                   | Forwarded to underlying calls; `mode` is overridden internally.|

#### Return Value

`Promise<{
  visible: {
    x:number,y:number,width:number,height:number,
    element:SVGElement,svgRoot:SVGSVGElement
  } | null,
  full:    {
    x:number,y:number,width:number,height:number,
    element:SVGElement,svgRoot:SVGSVGElement
  } | null
}>`

- `visible` may be `null` if the element is entirely outside the viewBox.  
- `full` may be `null` if nothing is rendered at all.

---

### `getSvgRootViewBoxExpansionForFullDrawing(svgRootOrId, options?)`

Helps you adjust a root `<svg>`’s `viewBox` so that it fully covers the drawing’s
**full visual bbox** (before viewBox clipping).

```js
const expansion =
  await SvgVisualBBox.getSvgRootViewBoxExpansionForFullDrawing('myRootSvg', {
    coarseFactor: 3,
    fineFactor: 24
  });

if (expansion) {
  const svg = document.getElementById('myRootSvg');
  const vb = expansion.newViewBox;
  svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.width} ${vb.height}`);
}
```

#### Parameters

| Parameter    | Type                         | Description                                      |
|-------------|------------------------------|--------------------------------------------------|
| `svgRootOrId`| `SVGSVGElement` \| `string` | Root `<svg>` element or its id (must be root).   |
| `options`   | `object`                     | Forwarded to `getSvgElementVisibleAndFullBBoxes`. |

#### Return Value

`Promise<{
  currentViewBox: {x:number,y:number,width:number,height:number},
  visibleBBox:    object|null,
  fullBBox:       object|null,
  padding: {left:number,top:number,right:number,bottom:number},
  newViewBox: {x:number,y:number,width:number,height:number}
} | null>`

If `fullBBox` is `null` (nothing draws), the function returns `null`.

The `padding` object tells you how many **user units** to expand on each side.
`newViewBox` is a suggested updated viewBox that fully contains the full visual bbox.

---

## 7. Node.js Test Harness

The Node script `sbb-test.cjs` allows you to run real SVGs through a headless
browser and record all bbox calculations.

### Setup

Install dependencies:

```bash
npm init -y              # if you don't have package.json yet
npm install puppeteer chrome-launcher
```

Ensure the following files exist:

- `SvgVisualBBox.js`
- `sbb-test.cjs`

### Running Tests

```bash
node sbb-test.cjs path/to/drawing.svg
```

This will:

1. Launch a headless browser with Puppeteer.  
2. Load a minimal HTML shell and inject the SVG.  
3. Inject `SvgVisualBBox.js`.  
4. Run all major library functions against:
   - the root `<svg>`,
   - a random internal SVG element,
   - multiple elements (union).  
5. Save results and logs.

### Understanding the Output

For an input file `drawing.svg`, the script writes:

| File                             | Contents                                                                      |
|----------------------------------|-------------------------------------------------------------------------------|
| `drawing-bbox-results.json`      | JSON object containing all measurement results.                              |
| `drawing-bbox-errors.log`        | Node/browser console output and any errors encountered.                      |

Open `drawing-bbox-results.json` to inspect properties like:

- `rootVisibleAndFull`
- `randomElementInfo`
- `randomVisibleAndFull`
- `randomAggressive`
- `unionRootAndRandom`
- `unionAll`
- `viewBoxExpansion`

These correspond directly to library calls and help validate correctness.

---

## 8. Common Workflows & Examples

### Checking if Text Fits a Shape

```js
(async () => {
  const svg = document.getElementById('iconSvg');

  const textBBox = await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive('label', {
    mode: 'clipped'
  });

  const rect = svg.getElementById
    ? svg.getElementById('labelBox')
    : document.getElementById('labelBox');

  const rx = parseFloat(rect.getAttribute('x'));
  const ry = parseFloat(rect.getAttribute('y'));
  const rw = parseFloat(rect.getAttribute('width'));
  const rh = parseFloat(rect.getAttribute('height'));

  const fits =
    textBBox &&
    textBBox.x >= rx &&
    textBBox.y >= ry &&
    textBBox.x + textBBox.width  <= rx + rw &&
    textBBox.y + textBBox.height <= ry + rh;

  console.log('Text fits?', !!fits);
})();
```

Because `textBBox` is in the same coordinate system as the rectangle, this check is
reliable even if the text has transforms, is affected by `viewBox`, or uses complex scripts.

### Comparing Visible vs Hidden Content

```js
(async () => {
  const { visible, full } =
    await SvgVisualBBox.getSvgElementVisibleAndFullBBoxes('rootSvg');

  console.log('Visible bbox:', visible);
  console.log('Full bbox   :', full);

  if (visible && full) {
    const extendsLeft  = full.x < visible.x;
    const extendsRight = full.x + full.width > visible.x + visible.width;
    const extendsTop   = full.y < visible.y;
    const extendsBottom= full.y + full.height > visible.y + visible.height;

    console.log('Extends outside viewBox?:', {
      left: extendsLeft,
      right: extendsRight,
      top: extendsTop,
      bottom: extendsBottom
    });
  }
})();
```

This is helpful to detect elements drawn outside the viewBox (e.g. when you want
to tidy up or auto‑expand the viewBox).

---

## 9. Limitations & Notes

### Security / CORS

The library uses `<canvas>` + `getImageData()` to read pixel data. This is subject to
standard browser security rules:

- All referenced images/fonts must be same‑origin or CORS‑enabled.
- Otherwise the canvas becomes “tainted” and `getImageData()` throws a `SecurityError`.

The functions will surface this as clear error messages.

### Performance

Two‑pass rasterization is deliberately conservative and CPU‑intensive:

- Avoid calling it in hot loops or continuous animations.
- Consider caching bboxes for elements that don’t change.
- You can lower `coarseFactor` and/or `fineFactor` for performance if you don’t need
  maximum precision.

### Fonts & Timing

Text layout can change as web fonts load. The library uses `document.fonts.ready`
when available to avoid measuring before fonts are ready, but you can control how
long to wait via `fontTimeoutMs` in options.

### Accuracy vs Resolution

The tightness of the bounding box depends on resolution:

- Higher `fineFactor` → more pixels per user unit → tighter bbox.
- For most UI/diagram scenarios, the defaults (`coarseFactor = 3`, `fineFactor = 24`)
  are already quite aggressive.

### Non‑Scaling Strokes

With `useLayoutScale = true`, the library derives a base pixels‑per‑user‑unit from
the actual layout (`getBoundingClientRect()` + `viewBox`). This makes it behave
more intuitively when you have `vector-effect="non-scaling-stroke"` or other
rendering effects that depend on screen pixel size.

---

That's the complete guide for using **SvgVisualBBox** both in the browser and through
the provided Node.js test harness.
