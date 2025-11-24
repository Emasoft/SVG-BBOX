# SVG-BBOX JavaScript API Documentation

Complete reference for using SVG-BBOX as a browser library.

---

## Table of Contents

1. [Installation](#installation)
2. [Quick Start](#quick-start)
3. [API Reference](#api-reference)
   - [waitForDocumentFonts](#waitfordocumentfonts)
   - [getSvgElementVisualBBoxTwoPassAggressive](#getsvgelementvisualbboxtwopassaggressive)
   - [getSvgElementsUnionVisualBBox](#getsvgelementsunionvisualbbox)
   - [getSvgElementVisibleAndFullBBoxes](#getsvgelementvisibleandfullbboxes)
   - [getSvgRootViewBoxExpansionForFullDrawing](#getsvgrootviewboxexpansionforfulldrawing)
   - [showTrueBBoxBorder](#showtruebboxborder) ⭐ NEW
4. [Examples](#examples)
5. [Error Handling](#error-handling)
6. [Browser Compatibility](#browser-compatibility)
7. [Security Considerations](#security-considerations)

---

## Installation

### Browser (CDN)

```html
<script src="https://unpkg.com/svg-bbox@latest/SvgVisualBBox.js"></script>
```

### NPM

```bash
npm install svg-bbox
```

```javascript
// ES Module
import SvgVisualBBox from 'svg-bbox';

// CommonJS
const SvgVisualBBox = require('svg-bbox');
```

### Local File

```html
<script src="./node_modules/svg-bbox/SvgVisualBBox.js"></script>
```

---

## Quick Start

```html
<!DOCTYPE html>
<html>
<head>
  <script src="https://unpkg.com/svg-bbox@latest/SvgVisualBBox.js"></script>
</head>
<body>
  <svg id="mySvg" viewBox="0 0 100 100" width="400" height="400">
    <text id="myText" x="50" y="50" font-size="20" text-anchor="middle">Hello SVG!</text>
  </svg>

  <script>
    (async () => {
      // Wait for fonts to load
      await SvgVisualBBox.waitForDocumentFonts();

      // Get accurate bounding box
      const bbox = await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive('#myText');
      console.log('BBox:', bbox); // {x, y, width, height}

      // Show visual border (debug helper)
      const result = await SvgVisualBBox.showTrueBBoxBorder('#myText');
      // Later: result.remove();
    })();
  </script>
</body>
</html>
```

---

## API Reference

### waitForDocumentFonts

Waits for all document fonts to load before computing bounding boxes.

#### Signature

```javascript
SvgVisualBBox.waitForDocumentFonts(doc?, timeoutMs?) → Promise<void>
```

#### Parameters

| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `doc` | `Document` | `document` | The document object |
| `timeoutMs` | `number` | `10000` | Maximum wait time in milliseconds |

#### Returns

`Promise<void>` - Resolves when fonts are loaded or timeout occurs

#### Example

```javascript
// Wait for fonts with default 10s timeout
await SvgVisualBBox.waitForDocumentFonts();

// Custom timeout
await SvgVisualBBox.waitForDocumentFonts(document, 5000);
```

#### Notes

- Always call this before computing text bounding boxes
- Uses the CSS Font Loading API when available
- Falls back to timeout if API not supported

---

### getSvgElementVisualBBoxTwoPassAggressive

Computes high-accuracy visual bounding box for a single SVG element using two-pass rasterization.

#### Signature

```javascript
SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(target, options?) → Promise<BBox>
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `target` | `string \| Element` | CSS selector or SVG element |
| `options` | `Object` | Configuration options |

#### Options Object

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `mode` | `'clipped' \| 'unclipped'` | `'clipped'` | Whether to respect viewBox clipping |
| `coarseFactor` | `number` | `3` | Resolution multiplier for pass 1 (rough scan) |
| `fineFactor` | `number` | `24` | Resolution multiplier for pass 2 (precise scan) |

#### Returns

`Promise<BBox>` where `BBox` is:

```typescript
{
  x: number;      // Left coordinate in SVG user space
  y: number;      // Top coordinate in SVG user space
  width: number;  // Width in SVG user units
  height: number; // Height in SVG user units
}
```

#### Example

```javascript
// By selector
const bbox = await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive('#myPath');

// By element reference
const element = document.querySelector('#myText');
const bbox = await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(element);

// With options
const bbox = await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive('#myElement', {
  mode: 'unclipped',  // Ignore viewBox clipping
  coarseFactor: 2,    // Faster but less accurate pass 1
  fineFactor: 32      // More accurate pass 2
});

console.log(`Element at (${bbox.x}, ${bbox.y}), size ${bbox.width}×${bbox.height}`);
```

#### Notes

- Returns coordinates in SVG user space (viewBox coordinates)
- Handles complex text (ligatures, RTL, CJK, Arabic)
- Works with filters, masks, strokes, markers
- Two-pass algorithm: coarse scan → refine region → precise scan

---

### getSvgElementsUnionVisualBBox

Computes the union bounding box of multiple SVG elements.

#### Signature

```javascript
SvgVisualBBox.getSvgElementsUnionVisualBBox(targets, options?) → Promise<BBox>
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `targets` | `Array<string \| Element>` | Array of CSS selectors or elements |
| `options` | `Object` | Same as `getSvgElementVisualBBoxTwoPassAggressive` |

#### Returns

`Promise<BBox>` - Bounding box that encloses all target elements

#### Example

```javascript
// Multiple selectors
const unionBbox = await SvgVisualBBox.getSvgElementsUnionVisualBBox([
  '#text1',
  '#text2',
  '#path1'
]);

// Mixed selectors and elements
const el = document.querySelector('#circle1');
const unionBbox = await SvgVisualBBox.getSvgElementsUnionVisualBBox([
  '#rect1',
  el,
  document.getElementById('poly1')
]);

console.log('Union bbox:', unionBbox);
```

#### Notes

- All elements must be in the same SVG root
- Returns smallest rectangle containing all elements
- Useful for grouping, layout calculations, export bounds

---

### getSvgElementVisibleAndFullBBoxes

Returns both visible (clipped) and full (unclipped) bounding boxes.

#### Signature

```javascript
SvgVisualBBox.getSvgElementVisibleAndFullBBoxes(target, options?) → Promise<Result>
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `target` | `string \| Element` | CSS selector or SVG element |
| `options` | `Object` | Same as `getSvgElementVisualBBoxTwoPassAggressive` |

#### Returns

`Promise<Result>` where `Result` is:

```typescript
{
  visible: BBox;  // BBox clipped to viewBox
  full: BBox;     // BBox ignoring viewBox (entire drawing)
}
```

#### Example

```javascript
const { visible, full } = await SvgVisualBBox.getSvgElementVisibleAndFullBBoxes('#mySvg');

console.log('Visible area:', visible);
console.log('Full drawing (including clipped):', full);

if (full.width > visible.width) {
  console.log('Content is clipped horizontally');
}
```

#### Use Cases

- Detect if content extends beyond viewBox
- Calculate required viewBox expansion
- Export preparation (knowing full drawing bounds)

---

### getSvgRootViewBoxExpansionForFullDrawing

Calculates how much to expand a viewBox to fully show all content.

#### Signature

```javascript
SvgVisualBBox.getSvgRootViewBoxExpansionForFullDrawing(svgRootOrId, options?) → Promise<Expansion>
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `svgRootOrId` | `string \| Element` | Root SVG selector or element |
| `options` | `Object` | Same as `getSvgElementVisualBBoxTwoPassAggressive` |

#### Returns

`Promise<Expansion>` where `Expansion` is:

```typescript
{
  currentViewBox: BBox;  // Current viewBox
  visibleBBox: BBox;     // Currently visible content
  fullBBox: BBox;        // Full drawing bounds
  padding: {             // Required padding on each side
    left: number;
    top: number;
    right: number;
    bottom: number;
  };
  newViewBox: BBox;      // Suggested new viewBox
}
```

#### Example

```javascript
const expansion = await SvgVisualBBox.getSvgRootViewBoxExpansionForFullDrawing('#mySvg');

console.log('Current viewBox:', expansion.currentViewBox);
console.log('Needs padding:', expansion.padding);

// Apply the suggested viewBox
const svg = document.querySelector('#mySvg');
const vb = expansion.newViewBox;
svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.width} ${vb.height}`);
```

#### Use Cases

- Fix clipped SVG content
- Auto-fit viewBox to drawing
- SVG export preparation

---

### showTrueBBoxBorder

⭐ **NEW** - Visual debug helper that displays a border around an element's true bounding box.

#### Signature

```javascript
SvgVisualBBox.showTrueBBoxBorder(target, options?) → Promise<Result>
```

#### Parameters

| Parameter | Type | Description |
|-----------|------|-------------|
| `target` | `string \| Element` | CSS selector, SVG element, or container (object/iframe) |
| `options` | `Object` | Border styling and behavior options |

#### Options Object

| Property | Type | Default | Description |
|----------|------|---------|-------------|
| `theme` | `string` | `'auto'` | Color theme: `'auto'`, `'light'`, or `'dark'`. Auto-detects system theme. |
| `borderColor` | `string` | Theme-based | Border color (CSS color value). Overrides theme. |
| `borderWidth` | `string` | `'2px'` | Border width |
| `borderStyle` | `string` | `'dashed'` | Border style (solid, dashed, dotted) |
| `padding` | `number` | `4` | Padding around border in pixels |
| `zIndex` | `number` | `999999` | Z-index for overlay |
| `bboxOptions` | `Object` | `{}` | Options for bbox computation |

#### Returns

`Promise<Result>` where `Result` is:

```typescript
{
  bbox: BBox;           // Computed bounding box
  overlay: HTMLElement; // The border overlay element
  remove: Function;     // Function to remove the border
}
```

#### Examples

##### Basic Usage

```javascript
// Show border with auto-detected theme color
const result = await SvgVisualBBox.showTrueBBoxBorder('#myText');

// Remove border later
setTimeout(() => result.remove(), 5000);
```

##### Force Theme

```javascript
// Force dark theme (white border) for light backgrounds
const result = await SvgVisualBBox.showTrueBBoxBorder('#myPath', {
  theme: 'dark'
});

// Force light theme (black border) for dark backgrounds
const result = await SvgVisualBBox.showTrueBBoxBorder('#myPath', {
  theme: 'light'
});
```

##### Custom Styling

```javascript
// Red solid border (overrides theme)
const result = await SvgVisualBBox.showTrueBBoxBorder('#myPath', {
  borderColor: 'red',
  borderWidth: '3px',
  borderStyle: 'solid',
  padding: 10
});
```

##### Multiple Elements

```javascript
// Show borders on all text elements
const texts = document.querySelectorAll('text');
const results = await Promise.all(
  Array.from(texts).map(el =>
    SvgVisualBBox.showTrueBBoxBorder(el, { borderColor: 'blue' })
  )
);

// Remove all borders
results.forEach(r => r.remove());
```

##### SVG in Object Tag

```javascript
// Works with <object> embedded SVG
const result = await SvgVisualBBox.showTrueBBoxBorder('#svgObject');
```

##### Dynamic SVGs

```javascript
// Border follows SVG on scroll/resize
const result = await SvgVisualBBox.showTrueBBoxBorder('#animatedSvg');

// Border automatically updates position
// Remove when done
document.getElementById('hideBtn').onclick = () => result.remove();
```

#### Features

- **Auto Theme Detection**: Automatically chooses visible color based on system dark/light theme
- **Non-Intrusive**: Overlay doesn't modify SVG content or interfere with interactions
- **Dynamic Updates**: Border follows SVG on scroll, resize, and window changes
- **All SVG Types**: Works with inline SVG, `<object>`, `<iframe>`, `<use>`, sprites, dynamic SVGs
- **Easy Cleanup**: Single `remove()` call removes border and all event listeners

#### Theme Colors

| Theme Mode | Border Color | Use Case |
|------------|--------------|----------|
| `'auto'` (default) | System theme-based | Adapts to user's OS theme preference |
| `'light'` | `rgba(0,0,0,0.6)` | Dark border for light backgrounds |
| `'dark'` | `rgba(255,255,255,0.8)` | Light border for dark backgrounds |
| Custom | `options.borderColor` | Any CSS color value |

#### Notes

- Border is a positioned overlay (`position: fixed`)
- Overlay has `pointer-events: none` - doesn't block clicks
- Automatically cleans up event listeners on `remove()`
- Border updates on window resize and scroll
- Returns null overlay if element has zero-size bbox

---

## Examples

### Example 1: Text Bounding Box

```html
<svg viewBox="0 0 200 100" width="400">
  <text id="greeting" x="100" y="50" text-anchor="middle" font-size="24">
    Hello World!
  </text>
</svg>

<script>
(async () => {
  await SvgVisualBBox.waitForDocumentFonts();

  const bbox = await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive('#greeting');

  console.log(`Text bbox: ${bbox.width} × ${bbox.height}`);

  // Show border for 3 seconds
  const result = await SvgVisualBBox.showTrueBBoxBorder('#greeting', {
    borderColor: 'green'
  });

  setTimeout(() => result.remove(), 3000);
})();
</script>
```

### Example 2: Multiple Elements Union

```html
<svg id="drawing" viewBox="0 0 300 200">
  <circle id="c1" cx="50" cy="50" r="30" fill="red"/>
  <rect id="r1" x="120" y="20" width="60" height="40" fill="blue"/>
  <path id="p1" d="M200,50 L250,100 L200,150 Z" fill="green"/>
</svg>

<script>
(async () => {
  // Get union of all shapes
  const union = await SvgVisualBBox.getSvgElementsUnionVisualBBox([
    '#c1', '#r1', '#p1'
  ]);

  console.log('Union bbox:', union);

  // Draw rectangle around union (for visualization)
  const svg = document.getElementById('drawing');
  const rect = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
  rect.setAttribute('x', union.x);
  rect.setAttribute('y', union.y);
  rect.setAttribute('width', union.width);
  rect.setAttribute('height', union.height);
  rect.setAttribute('fill', 'none');
  rect.setAttribute('stroke', 'orange');
  rect.setAttribute('stroke-width', '2');
  svg.appendChild(rect);
})();
</script>
```

### Example 3: Fix Clipped Content

```html
<svg id="clippedSvg" viewBox="0 0 100 100" width="400">
  <text x="10" y="50" font-size="30">This text is too long!</text>
</svg>

<button id="fixBtn">Fix Clipping</button>

<script>
document.getElementById('fixBtn').onclick = async () => {
  await SvgVisualBBox.waitForDocumentFonts();

  const expansion = await SvgVisualBBox.getSvgRootViewBoxExpansionForFullDrawing('#clippedSvg');

  console.log('Required padding:', expansion.padding);

  // Apply new viewBox
  const svg = document.getElementById('clippedSvg');
  const vb = expansion.newViewBox;
  svg.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.width} ${vb.height}`);

  alert('ViewBox expanded to show all content!');
};
</script>
```

### Example 4: Debug All SVG Elements

```javascript
// Show borders on all SVG elements for debugging
async function debugAllSvgElements(svgSelector) {
  const svg = document.querySelector(svgSelector);
  const elements = svg.querySelectorAll('*');

  const results = [];
  for (const el of elements) {
    if (el.id || el.tagName) {
      try {
        const result = await SvgVisualBBox.showTrueBBoxBorder(el, {
          borderColor: 'rgba(255,0,0,0.5)',
          borderWidth: '1px'
        });
        results.push(result);
      } catch (e) {
        console.warn('Could not show border for', el, e);
      }
    }
  }

  // Return cleanup function
  return () => results.forEach(r => r.remove());
}

// Usage
const cleanup = await debugAllSvgElements('#mySvg');
// Later: cleanup();
```

### Example 5: Responsive SVG with Border

```html
<svg id="responsiveSvg" viewBox="0 0 200 200" width="100%">
  <circle id="dot" cx="100" cy="100" r="50" fill="purple"/>
</svg>

<script>
(async () => {
  // Show border that follows responsive SVG
  const result = await SvgVisualBBox.showTrueBBoxBorder('#dot', {
    borderColor: 'yellow',
    borderWidth: '3px'
  });

  // Border automatically updates on window resize!
  // User can resize browser - border follows

  // Remove after 10 seconds
  setTimeout(() => result.remove(), 10000);
})();
</script>
```

---

## Error Handling

All API functions return Promises and may reject with errors:

```javascript
try {
  const bbox = await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive('#nonexistent');
} catch (error) {
  console.error('Failed to compute bbox:', error.message);
}
```

### Common Errors

| Error Message | Cause | Solution |
|--------------|-------|----------|
| "SVG element not found" | Invalid selector | Check element ID/selector |
| "Target is not an SVG element" | Wrong element type | Ensure target is SVG element |
| "Canvas tainted" | CORS issue | Ensure same-origin or CORS headers |
| "Element has zero-size bounding box" | Empty/invisible element | Check element visibility and content |

---

## Browser Compatibility

### Required Features

- **Canvas API**: For rasterization (all modern browsers)
- **SVG**: Native SVG support (IE9+, all modern browsers)
- **Promises**: Async/await support (ES2017+)
- **matchMedia**: For theme detection in `showTrueBBoxBorder` (IE10+)

### Tested Browsers

| Browser | Version | Status |
|---------|---------|--------|
| Chrome | 90+ | ✅ Full support |
| Firefox | 88+ | ✅ Full support |
| Safari | 14+ | ✅ Full support |
| Edge | 90+ | ✅ Full support |
| Opera | 76+ | ✅ Full support |

### Polyfills

For older browsers, include:

```html
<!-- Promise polyfill for IE11 -->
<script src="https://cdn.jsdelivr.net/npm/promise-polyfill@8/dist/polyfill.min.js"></script>

<!-- Fetch polyfill if using dynamic SVG loading -->
<script src="https://cdn.jsdelivr.net/npm/whatwg-fetch@3/dist/fetch.umd.js"></script>
```

---

## Security Considerations

### CORS and Canvas Tainting

When an SVG references external resources (images, fonts, stylesheets), the canvas becomes "tainted" for security reasons.

#### Problem

```javascript
// This will throw SecurityError if image.png is from different origin
<svg>
  <image href="https://other-domain.com/image.png" />
</svg>

const bbox = await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive('image');
// SecurityError: Failed to execute 'getImageData' on 'CanvasRenderingContext2D'
```

#### Solutions

1. **Same Origin**: Host all resources on same domain
2. **CORS Headers**: Server must send `Access-Control-Allow-Origin` header
3. **Data URLs**: Embed resources as data: URLs
4. **Proxy**: Proxy external resources through your server

```javascript
// Good: same origin
<image href="/images/logo.png" />

// Good: CORS-enabled CDN
<image href="https://cors-enabled-cdn.com/image.png" />

// Good: data URL
<image href="data:image/png;base64,iVBORw0KG..." />
```

### Content Security Policy

If your site uses CSP, ensure these directives allow canvas operations:

```http
Content-Security-Policy:
  img-src 'self' data: https://your-cdn.com;
  style-src 'self' 'unsafe-inline';
```

---

## Performance Tips

1. **Wait for Fonts Once**: Call `waitForDocumentFonts()` once at page load, not before every bbox computation

2. **Batch Operations**: Compute multiple bboxes in parallel:
   ```javascript
   const bboxes = await Promise.all([
     SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive('#el1'),
     SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive('#el2'),
     SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive('#el3')
   ]);
   ```

3. **Adjust Resolution**: Lower `fineFactor` for faster (but less precise) results:
   ```javascript
   const bbox = await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive('#el', {
     fineFactor: 12  // Faster than default 24
   });
   ```

4. **Cache Results**: If SVG doesn't change, cache bbox results:
   ```javascript
   const bboxCache = new Map();

   async function getCachedBBox(selector) {
     if (!bboxCache.has(selector)) {
       const bbox = await SvgVisualBBox.getSvgElementVisualBBoxTwoPassAggressive(selector);
       bboxCache.set(selector, bbox);
     }
     return bboxCache.get(selector);
   }
   ```

---

## Support

- **GitHub Issues**: https://github.com/Emasoft/SVG-BBOX/issues
- **Documentation**: https://github.com/Emasoft/SVG-BBOX
- **NPM Package**: https://www.npmjs.com/package/svg-bbox

---

## License

MIT License - See LICENSE file for details
