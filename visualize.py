#!/usr/bin/env python3
"""
visualize.py — Apply a Mohawk floor texture to a room photo via gpt-image-1

Usage:
    python visualize.py <room_photo> <sku>
    python visualize.py <room_photo> --line-code WEK60 --color-code 127

Arguments:
    room_photo      Path to the room photo (JPEG or PNG)
    sku             Full SKU string, e.g. "32700-127"

Options:
    --line-code CODE      Alternative lookup: product line code (e.g. WEK60)
    --color-code CODE     Alternative lookup: color code (e.g. 127) — use with --line-code
    --prompt TEXT         Override the default visualization prompt
    --size SIZE           1024x1024 (default) | 1536x1024 | 1024x1536
    --out-dir DIR         Output directory (default: visualizer-assets/results)
    --catalog FILE        Path to master_catalog.json
    --api-key-file FILE   Path to OpenAI API key file

Examples:
    python visualize.py living_room.jpg 32700-127
    python visualize.py bedroom.png 32700-841 --size 1536x1024
    python visualize.py kitchen.jpg --line-code WEK60 --color-code 859

API key: /root/.openclaw/.openai-api-key  (default)
Model:   gpt-image-1 via POST /v1/images/edits
Room photo is sent first; texture swatch second — this order is intentional.
"""

import argparse
import base64
import json
import re
import sys
import time
import urllib.error
import urllib.request
from pathlib import Path

ASSETS_DIR = Path(__file__).parent / "visualizer-assets"
MASTER_CATALOG_DEFAULT = ASSETS_DIR / "master_catalog.json"
API_KEY_FILE_DEFAULT = Path("/root/.openclaw/.openai-api-key")
RESULTS_DIR_DEFAULT = ASSETS_DIR / "results"

DEFAULT_PROMPT = (
    "Replace all of the flooring in this room with the wood flooring texture "
    "shown in the second image. Keep every other element exactly as it is: "
    "furniture, walls, ceiling, lighting, rugs, windows, and all other objects. "
    "The new floor should look natural, properly perspective-corrected, and "
    "photorealistic. Do not change anything except the floor surface."
)

VALID_SIZES = {"1024x1024", "1536x1024", "1024x1536"}


# ── Catalog lookup ─────────────────────────────────────────────────────────────

def load_catalog(catalog_path: Path) -> dict:
    if not catalog_path.exists():
        print(f"Error: master_catalog.json not found at {catalog_path}", file=sys.stderr)
        print("Run:  python ingest.py --seed-all   to build it from existing catalog.json files.",
              file=sys.stderr)
        sys.exit(1)
    with open(catalog_path) as f:
        return json.load(f)


def find_colorway(catalog: dict, sku: str = None,
                  line_code: str = None, color_code: str = None) -> dict:
    """Return a colorway dict with line_code and product_line merged in."""
    if sku:
        # Fast path: SKU index
        entry = catalog.get("sku_index", {}).get(sku)
        if entry:
            return entry
        # Slow path: scan products (handles catalogs built before sku_index existed)
        for product in catalog.get("products", []):
            for cw in product.get("colorways", []):
                if cw.get("sku") == sku:
                    return {**cw,
                            "line_code": product["line_code"],
                            "product_line": product.get("product_line", "")}
        print(f"Error: SKU '{sku}' not found in master_catalog.json", file=sys.stderr)
        _list_available(catalog)
        sys.exit(1)

    elif line_code and color_code:
        for product in catalog.get("products", []):
            if product.get("line_code") == line_code:
                for cw in product.get("colorways", []):
                    if cw.get("color_code") == color_code:
                        return {**cw,
                                "line_code": line_code,
                                "product_line": product.get("product_line", "")}
        print(f"Error: {line_code}-{color_code} not found in master_catalog.json",
              file=sys.stderr)
        _list_available(catalog)
        sys.exit(1)

    else:
        print("Error: provide a SKU positional arg or both --line-code and --color-code",
              file=sys.stderr)
        sys.exit(1)


def _list_available(catalog: dict) -> None:
    """Print available SKUs to stderr to help the user."""
    index = catalog.get("sku_index", {})
    if not index:
        return
    print("\nAvailable SKUs:", file=sys.stderr)
    for sku, entry in sorted(index.items()):
        print(f"  {sku:15s}  {entry.get('line_code','')} — {entry.get('color_name','')}",
              file=sys.stderr)


# ── Image I/O ─────────────────────────────────────────────────────────────────

def read_image(path: Path) -> tuple[bytes, str]:
    """Return (bytes, mime_type). Detects PNG, JPEG, WEBP by magic bytes."""
    data = path.read_bytes()
    if data[:8] == b"\x89PNG\r\n\x1a\n":
        return data, "image/png"
    if data[:2] == b"\xff\xd8":
        return data, "image/jpeg"
    if data[:4] == b"RIFF" and data[8:12] == b"WEBP":
        return data, "image/webp"
    # Default: treat as PNG (pdfimages outputs PNG)
    return data, "image/png"


# ── Multipart builder ─────────────────────────────────────────────────────────

def build_multipart(fields: list) -> tuple[bytes, str]:
    """
    Build a multipart/form-data body without third-party libraries.

    fields is a list of either:
      ("name", "string_value")                              — text field
      ("name", "filename", bytes_data, "mime/type")         — file field
    """
    boundary = "----FloraVisualizerBoundary" + format(int(time.time() * 1000), "x")
    body = b""

    for field in fields:
        if len(field) == 2:
            name, value = field
            body += (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'
                f"{value}\r\n"
            ).encode()
        else:
            name, filename, data, content_type = field
            header = (
                f"--{boundary}\r\n"
                f'Content-Disposition: form-data; name="{name}"; filename="{filename}"\r\n'
                f"Content-Type: {content_type}\r\n\r\n"
            ).encode()
            body += header + data + b"\r\n"

    body += f"--{boundary}--\r\n".encode()
    content_type_header = f"multipart/form-data; boundary={boundary}"
    return body, content_type_header


# ── OpenAI call ───────────────────────────────────────────────────────────────

def call_images_edits(
    api_key: str,
    room_bytes: bytes,
    room_mime: str,
    texture_bytes: bytes,
    texture_mime: str,
    prompt_text: str,
    size: str,
) -> bytes:
    """
    POST to /v1/images/edits with model=gpt-image-1.
    Room photo first, texture swatch second (per Seth's confirmed test).
    Returns raw PNG bytes.
    """
    fields = [
        ("model",  "gpt-image-1"),
        ("prompt", prompt_text),
        ("n",      "1"),
        ("size",   size),
        # image[] repeated — room first, texture second
        ("image[]", "room.png",    room_bytes,    room_mime),
        ("image[]", "texture.png", texture_bytes, texture_mime),
    ]
    body, ct_header = build_multipart(fields)

    req = urllib.request.Request(
        "https://api.openai.com/v1/images/edits",
        data=body,
        headers={
            "Authorization": f"Bearer {api_key}",
            "Content-Type": ct_header,
        },
        method="POST",
    )

    try:
        print("  Waiting for gpt-image-1 (~15–30s)...")
        with urllib.request.urlopen(req, timeout=120) as resp:
            response = json.loads(resp.read())
    except urllib.error.HTTPError as e:
        err_body = e.read().decode(errors="replace")
        print(f"OpenAI API error {e.code}: {err_body}", file=sys.stderr)
        sys.exit(1)
    except urllib.error.URLError as e:
        print(f"Network error: {e.reason}", file=sys.stderr)
        sys.exit(1)

    item = response.get("data", [{}])[0]

    # gpt-image-1 returns b64_json; older models may return a URL
    if "b64_json" in item:
        return base64.b64decode(item["b64_json"])

    if "url" in item:
        print("  (response is URL; fetching...)")
        with urllib.request.urlopen(item["url"], timeout=60) as r:
            return r.read()

    print("Error: no image data in API response:", file=sys.stderr)
    print(json.dumps(response, indent=2), file=sys.stderr)
    sys.exit(1)


# ── Main ──────────────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("room_photo", help="Path to room photo (JPEG or PNG)")
    parser.add_argument("sku", nargs="?", help="Full SKU, e.g. 32700-127")
    parser.add_argument("--line-code",  help="Line code (alternative to full SKU)")
    parser.add_argument("--color-code", help="Color code, e.g. 127 (use with --line-code)")
    parser.add_argument("--prompt", dest="prompt_text", default=DEFAULT_PROMPT,
                        help="Override the default visualization prompt")
    parser.add_argument("--size", default="1024x1024", choices=sorted(VALID_SIZES),
                        help="Output image size (default: 1024x1024)")
    parser.add_argument("--out-dir", default=str(RESULTS_DIR_DEFAULT),
                        help="Output directory for result images")
    parser.add_argument("--catalog", default=str(MASTER_CATALOG_DEFAULT),
                        help="Path to master_catalog.json")
    parser.add_argument("--api-key-file", default=str(API_KEY_FILE_DEFAULT),
                        help="Path to file containing the OpenAI API key")
    args = parser.parse_args()

    # ── Validate inputs ────────────────────────────────────────────────────
    if not args.sku and not (args.line_code and args.color_code):
        parser.error("Provide a SKU positional argument, or --line-code + --color-code")

    room_photo = Path(args.room_photo).resolve()
    if not room_photo.exists():
        print(f"Error: room photo not found: {room_photo}", file=sys.stderr)
        sys.exit(1)

    api_key_file = Path(args.api_key_file)
    if not api_key_file.exists():
        print(f"Error: API key file not found: {api_key_file}", file=sys.stderr)
        sys.exit(1)
    api_key = api_key_file.read_text().strip()

    # ── Catalog lookup ─────────────────────────────────────────────────────
    catalog = load_catalog(Path(args.catalog))
    colorway = find_colorway(
        catalog,
        sku=args.sku,
        line_code=args.line_code,
        color_code=args.color_code,
    )

    line_code    = colorway["line_code"]
    texture_file = colorway["texture_file"]
    color_name   = colorway["color_name"]
    sku          = colorway["sku"]
    product_line = colorway.get("product_line", line_code)
    texture_px   = colorway.get("texture_px", [])

    texture_path = ASSETS_DIR / line_code / texture_file
    if not texture_path.exists():
        print(f"Error: texture file not found: {texture_path}", file=sys.stderr)
        print(f"  Expected at: visualizer-assets/{line_code}/{texture_file}",
              file=sys.stderr)
        sys.exit(1)

    # ── Report ─────────────────────────────────────────────────────────────
    print(f"\n=== FLORA Visualizer ===")
    print(f"Room photo  : {room_photo.name}")
    print(f"Material    : {product_line} — {color_name} ({sku})")
    print(f"Texture     : {texture_file}  {texture_px}")
    print(f"Output size : {args.size}")

    # ── Load images ────────────────────────────────────────────────────────
    room_bytes, room_mime = read_image(room_photo)
    texture_bytes, texture_mime = read_image(texture_path)

    # ── Call API ───────────────────────────────────────────────────────────
    result_bytes = call_images_edits(
        api_key,
        room_bytes, room_mime,
        texture_bytes, texture_mime,
        args.prompt_text,
        args.size,
    )

    # ── Save result ────────────────────────────────────────────────────────
    out_dir = Path(args.out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)

    timestamp = int(time.time())
    safe_sku  = re.sub(r"[^\w-]", "-", sku)
    safe_name = re.sub(r"[^\w-]", "-", color_name.lower())
    out_name  = f"{timestamp}-{safe_sku}-{safe_name}.png"
    out_path  = out_dir / out_name

    out_path.write_bytes(result_bytes)

    print(f"\n✓ Result saved: {out_path}")
    print(f"  {len(result_bytes):,} bytes\n")


if __name__ == "__main__":
    main()
