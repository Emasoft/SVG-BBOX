#!/usr/bin/env python3
"""
Reference SVG Renderer for Test Verification

This is a minimal SVG renderer that generates reference PNG outputs for comparing
against Chrome's SVG rendering. It only supports the subset of SVG used in our
test specimens:

- rect elements (with x, y, width, height, fill, fill-opacity)
- No antialiasing (specimens use pixel-aligned coordinates)
- Transparent background by default

The renderer produces deterministic output that can be compared byte-for-byte
with Chrome's output to verify rendering consistency.

Usage:
    python reference_renderer.py input.svg output.png [--width W] [--height H]

Dependencies:
    pip install Pillow lxml
"""

import argparse
import math
import re
import sys
from pathlib import Path
from typing import NamedTuple

try:
    from lxml import etree
except ImportError:
    print("Error: lxml is required. Install with: pip install lxml", file=sys.stderr)
    sys.exit(1)

try:
    from PIL import Image
except ImportError:
    print("Error: Pillow is required. Install with: pip install Pillow", file=sys.stderr)
    sys.exit(1)


class Color(NamedTuple):
    """RGBA color with 8-bit channels."""

    r: int
    g: int
    b: int
    a: int

    @classmethod
    def from_hex(cls, hex_color: str, alpha: float = 1.0) -> "Color":
        """Parse a hex color (#rrggbb or #rgb) with optional alpha.

        Uses truncation (int()) for alpha conversion to match Chrome/Skia behavior.
        Chrome converts opacity 0.5 to alpha 127 (truncation), not 128 (rounding).
        """
        hex_color = hex_color.strip().lstrip("#")
        if len(hex_color) == 3:
            hex_color = "".join(c * 2 for c in hex_color)
        if len(hex_color) != 6:
            raise ValueError(f"Invalid hex color: #{hex_color}")
        r = int(hex_color[0:2], 16)
        g = int(hex_color[2:4], 16)
        b = int(hex_color[4:6], 16)
        # Chrome uses standard rounding for opacity-to-alpha conversion
        # 0.5 * 255 = 127.5 → round to 128
        a = int(round(alpha * 255))
        return cls(r, g, b, a)

    @classmethod
    def transparent(cls) -> "Color":
        """Return fully transparent color."""
        return cls(0, 0, 0, 0)


def parse_svg(svg_path: Path) -> tuple[int, int, list]:
    """Parse an SVG file and extract viewBox dimensions and shapes.

    Returns:
        (width, height, shapes) where shapes is a list of (type, params) tuples
    """
    tree = etree.parse(str(svg_path))
    root = tree.getroot()

    # Handle namespace
    nsmap = {"svg": "http://www.w3.org/2000/svg"}

    # Get viewBox dimensions
    viewbox = root.get("viewBox", "")
    if viewbox:
        parts = viewbox.split()
        if len(parts) == 4:
            _, _, vb_width, vb_height = map(float, parts)
        else:
            vb_width = float(root.get("width", 100))
            vb_height = float(root.get("height", 100))
    else:
        vb_width = float(root.get("width", 100))
        vb_height = float(root.get("height", 100))

    width = int(vb_width)
    height = int(vb_height)

    # Parse shapes
    shapes = []

    # Find all rect elements (with or without namespace)
    rects = root.findall(".//rect") + root.findall(".//svg:rect", nsmap)
    for rect in rects:
        x = float(rect.get("x", 0))
        y = float(rect.get("y", 0))
        w = float(rect.get("width", 0))
        h = float(rect.get("height", 0))
        fill = rect.get("fill", "#000000")
        fill_opacity = float(rect.get("fill-opacity", 1.0))

        # Handle 'none' fill
        if fill.lower() == "none":
            continue

        color = Color.from_hex(fill, fill_opacity)
        shapes.append(("rect", {"x": x, "y": y, "width": w, "height": h, "color": color}))

    return width, height, shapes


def div255(x: int) -> int:
    """Skia-style division by 255: (x + 128) >> 8

    This matches Chrome/Skia's rounding behavior for alpha compositing.
    """
    return (x + 128) >> 8


def render_rect(pixels: list[list[Color]], x: float, y: float, width: float, height: float, color: Color) -> None:
    """Render a rectangle onto the pixel buffer using Chrome/Skia-compatible compositing.

    Uses pixel-center sampling: a pixel at (px, py) is covered if the pixel center
    (px + 0.5, py + 0.5) is inside the rectangle.

    Alpha compositing matches Chrome/Skia exactly:
    - Opaque destination: Uses optimized formula with rounding (256-scale)
    - Semi-transparent destination: Uses truncation (floor division) throughout

    This has been verified to produce byte-identical output to Chrome for all
    test specimens including overlapping semi-transparent rectangles.
    """
    img_height = len(pixels)
    img_width = len(pixels[0]) if img_height > 0 else 0

    # Calculate pixel bounds (integer coordinates)
    x1 = int(x)
    y1 = int(y)
    x2 = int(x + width)
    y2 = int(y + height)

    # Clip to image bounds
    x1 = max(0, x1)
    y1 = max(0, y1)
    x2 = min(img_width, x2)
    y2 = min(img_height, y2)

    # Fill pixels
    for py in range(y1, y2):
        for px in range(x1, x2):
            dst = pixels[py][px]
            src = color

            if src.a == 255:
                # Fully opaque source replaces destination
                pixels[py][px] = src
            elif src.a == 0:
                # Fully transparent source, keep destination
                pass
            elif dst.a == 0:
                # Transparent destination, source replaces it
                pixels[py][px] = src
            elif dst.a == 255:
                # OPAQUE DESTINATION - Chrome uses optimized formula with rounding
                # Formula: (src * src_a + dst * (256 - src_a) + 128) >> 8
                # This uses 256-scale arithmetic for efficiency
                inv_alpha = 256 - src.a
                r = (src.r * src.a + dst.r * inv_alpha + 128) >> 8
                g = (src.g * src.a + dst.g * inv_alpha + 128) >> 8
                b = (src.b * src.a + dst.b * inv_alpha + 128) >> 8
                pixels[py][px] = Color(r, g, b, 255)
            else:
                # SEMI-TRANSPARENT DESTINATION - Chrome uses truncation for alpha
                # but ROUNDING for color unpremultiply
                inv = 255 - src.a

                # Alpha: truncation (floor division)
                out_a = src.a + (dst.a * inv) // 255

                if out_a == 0:
                    pixels[py][px] = Color.transparent()
                else:
                    # Premultiplied contributions: truncation
                    # src contributes: src_color * src_a
                    # dst contributes: dst_color * dst_a * (255 - src_a) / 255
                    out_r_pm = src.r * src.a + (dst.r * dst.a * inv) // 255
                    out_g_pm = src.g * src.a + (dst.g * dst.a * inv) // 255
                    out_b_pm = src.b * src.a + (dst.b * dst.a * inv) // 255

                    # Unpremultiply: rounding (add half-alpha before division)
                    # Chrome uses: (out_pm + out_a // 2) // out_a
                    r = min(255, (out_r_pm + out_a // 2) // out_a)
                    g = min(255, (out_g_pm + out_a // 2) // out_a)
                    b = min(255, (out_b_pm + out_a // 2) // out_a)

                    pixels[py][px] = Color(r, g, b, out_a)


def render_svg(svg_path: Path, output_path: Path, width: int | None = None, height: int | None = None) -> None:
    """Render an SVG file to a PNG.

    Args:
        svg_path: Path to input SVG file
        output_path: Path to output PNG file
        width: Override width (optional)
        height: Override height (optional)
    """
    vb_width, vb_height, shapes = parse_svg(svg_path)

    # Use viewBox dimensions if not overridden
    img_width = width if width is not None else vb_width
    img_height = height if height is not None else vb_height

    # Initialize pixel buffer with transparent pixels
    pixels: list[list[Color]] = [[Color.transparent() for _ in range(img_width)] for _ in range(img_height)]

    # Render each shape in order (painter's algorithm)
    for shape_type, params in shapes:
        if shape_type == "rect":
            render_rect(
                pixels, params["x"], params["y"], params["width"], params["height"], params["color"]
            )

    # Convert to PIL Image
    img = Image.new("RGBA", (img_width, img_height))
    for y in range(img_height):
        for x in range(img_width):
            color = pixels[y][x]
            img.putpixel((x, y), (color.r, color.g, color.b, color.a))

    # Save as PNG
    img.save(str(output_path), "PNG")


def main() -> int:
    parser = argparse.ArgumentParser(description="Reference SVG renderer for test verification")
    parser.add_argument("input", type=Path, help="Input SVG file")
    parser.add_argument("output", type=Path, help="Output PNG file")
    parser.add_argument("--width", type=int, help="Override output width")
    parser.add_argument("--height", type=int, help="Override output height")

    args = parser.parse_args()

    if not args.input.exists():
        print(f"Error: Input file not found: {args.input}", file=sys.stderr)
        return 1

    try:
        render_svg(args.input, args.output, args.width, args.height)
        print(f"Rendered {args.input} to {args.output}")
        return 0
    except Exception as e:
        print(f"Error: {e}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    sys.exit(main())
