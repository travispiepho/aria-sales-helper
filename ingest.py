#!/usr/bin/env python3
"""
ingest.py — Mohawk sell-sheet PDF → visualizer-assets catalog

Extracts color swatches from a Mohawk sell-sheet PDF, maps them to color
names and SKUs (interactively or via CLI args), renames the PNGs, and writes:
  visualizer-assets/{LINE_CODE}/catalog.json
  visualizer-assets/master_catalog.json  (merged/updated)

Usage:
    python ingest.py <pdf_path> [options]
    python ingest.py --seed-all             # bootstrap master_catalog from existing catalog.json files

Requires: poppler-utils (pdfimages, pdftotext)
    sudo apt install poppler-utils

Dependencies: none beyond the standard library (no Pillow needed)
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile
import unicodedata
from pathlib import Path

ASSETS_DIR = Path(__file__).parent / "visualizer-assets"
MASTER_CATALOG = ASSETS_DIR / "master_catalog.json"


# ── Helpers ────────────────────────────────────────────────────────────────────

def to_slug(text: str) -> str:
    text = unicodedata.normalize("NFKD", text)
    text = text.encode("ascii", "ignore").decode("ascii")
    text = re.sub(r"[^\w\s-]", "", text.lower())
    text = re.sub(r"[\s_]+", "-", text.strip())
    return re.sub(r"-+", "-", text).strip("-")


def png_dimensions(path: Path) -> tuple[int, int]:
    """Read width, height from PNG IHDR chunk — no PIL needed."""
    try:
        with open(path, "rb") as f:
            sig = f.read(8)
            if sig != b"\x89PNG\r\n\x1a\n":
                return (0, 0)
            f.read(4)   # IHDR length
            f.read(4)   # b'IHDR'
            w = int.from_bytes(f.read(4), "big")
            h = int.from_bytes(f.read(4), "big")
        return (w, h)
    except Exception:
        return (0, 0)


def prompt(msg: str, default: str = "") -> str:
    suffix = f" [{default}]" if default else ""
    val = input(f"{msg}{suffix}: ").strip()
    return val if val else default


# ── PDF extraction ─────────────────────────────────────────────────────────────

def extract_images(pdf_path: Path, tmpdir: Path) -> list[Path]:
    """Run pdfimages -png; return sorted list of output PNGs."""
    prefix = tmpdir / "img"
    result = subprocess.run(
        ["pdfimages", "-png", str(pdf_path), str(prefix)],
        capture_output=True, text=True,
    )
    if result.returncode != 0:
        print(f"pdfimages error: {result.stderr}", file=sys.stderr)
        sys.exit(1)
    return sorted(tmpdir.glob("img-*.png"))


def extract_text(pdf_path: Path) -> str:
    """Extract raw text from PDF with pdftotext."""
    result = subprocess.run(
        ["pdftotext", str(pdf_path), "-"],
        capture_output=True, text=True,
    )
    return result.stdout if result.returncode == 0 else ""


def find_color_candidates(text: str) -> list[dict]:
    """
    Parse Mohawk sell-sheet text for color names and SKUs.
    Mohawk SKU pattern: base_number-color_code  (e.g. 32700-127, WEK60-127)
    Color names: Title Case multi-word phrases
    Returns list of {color_name, sku, color_code}.
    """
    # Pattern: something-digits (e.g. 32700-127 or WEK60-127)
    sku_re = re.compile(r'\b([A-Z0-9]+-\d{3,})\b')
    # Title Case 2–5 word phrases — avoid all-caps section headers
    name_re = re.compile(r'\b([A-Z][a-z]+(?:\s+[A-Z][a-z]+){1,4})\b')

    _SKIP = {"Product Line", "Floor Type", "Color Name", "Shade Variation",
             "Plank Width", "Plank Length"}

    candidates = []
    for line in text.split("\n"):
        line = line.strip()
        if not line:
            continue
        skus = sku_re.findall(line)
        names = [n for n in name_re.findall(line) if n not in _SKIP]
        for sku in skus:
            parts = sku.rsplit("-", 1)
            color_code = parts[-1] if len(parts) > 1 else ""
            name = names[0] if names else ""
            if name:
                candidates.append({
                    "color_name": name,
                    "sku": sku,
                    "color_code": color_code,
                })
    return candidates


def filter_swatches(images: list[Path]) -> list[Path]:
    """
    Filter to images that look like swatches:
      - At least 80×80 px
      - Aspect ratio 0.4 – 2.5  (roughly square; excludes banners and logos)
    """
    out = []
    for img in images:
        w, h = png_dimensions(img)
        if w < 80 or h < 80:
            continue
        ratio = w / h if h else 0
        if 0.4 <= ratio <= 2.5:
            out.append(img)
    return out


# ── Catalog I/O ───────────────────────────────────────────────────────────────

def load_master_catalog() -> dict:
    if MASTER_CATALOG.exists():
        with open(MASTER_CATALOG) as f:
            return json.load(f)
    return {"products": [], "sku_index": {}}


def save_master_catalog(mc: dict) -> None:
    MASTER_CATALOG.parent.mkdir(parents=True, exist_ok=True)
    with open(MASTER_CATALOG, "w") as f:
        json.dump(mc, f, indent=2)
    print(f"  master_catalog.json → {MASTER_CATALOG}")


def merge_into_master(mc: dict, catalog: dict) -> None:
    """Add or replace a product by line_code in master_catalog."""
    line_code = catalog["line_code"]

    # Replace existing entry for this line_code
    mc["products"] = [p for p in mc["products"] if p.get("line_code") != line_code]
    mc["products"].append(catalog)

    # Rebuild SKU index entries for this line_code
    mc["sku_index"] = {
        k: v for k, v in mc["sku_index"].items()
        if v.get("line_code") != line_code
    }
    for cw in catalog.get("colorways", []):
        mc["sku_index"][cw["sku"]] = {
            "line_code": line_code,
            "product_line": catalog.get("product_line", ""),
            "sku": cw["sku"],
            "color_code": cw.get("color_code", ""),
            "color_name": cw["color_name"],
            "texture_file": cw["texture_file"],
            "texture_px": cw.get("texture_px", [0, 0]),
        }


# ── Seed mode: build master_catalog from existing catalog.json files ──────────

def cmd_seed_all(out_dir: Path) -> None:
    """Scan visualizer-assets for catalog.json files and rebuild master_catalog.json."""
    print(f"Seeding master_catalog.json from {out_dir}...")
    mc = {"products": [], "sku_index": {}}
    found = sorted(out_dir.rglob("catalog.json"))
    for cat_path in found:
        if cat_path.parent == out_dir:
            continue  # skip a catalog.json at the root level (shouldn't exist)
        try:
            with open(cat_path) as f:
                catalog = json.load(f)
            line_code = catalog.get("line_code", cat_path.parent.name)
            catalog["line_code"] = line_code
            merge_into_master(mc, catalog)
            colorway_count = len(catalog.get("colorways", []))
            print(f"  + {line_code}: {colorway_count} colorway(s) from {cat_path}")
        except Exception as e:
            print(f"  ! Skipped {cat_path}: {e}", file=sys.stderr)
    save_master_catalog(mc)
    total = len(mc["sku_index"])
    print(f"\n✓ master_catalog.json built: {len(mc['products'])} product(s), {total} SKU(s)")


# ── Main ingest flow ──────────────────────────────────────────────────────────

def cmd_ingest(args: argparse.Namespace) -> None:
    pdf_path = Path(args.pdf_path).resolve()
    if not pdf_path.exists():
        print(f"Error: {pdf_path} not found", file=sys.stderr)
        sys.exit(1)

    out_base = Path(args.out_dir)
    print(f"\n=== FLORA ingest: {pdf_path.name} ===\n")

    # ── Gather product metadata ─────────────────────────────────────────────
    line_code   = (args.line_code   or prompt("Line code (e.g. WEK80)")).upper()
    product_line = args.product_line or prompt("Product line display name")
    floor_type   = args.floor_type   or prompt("Floor type (e.g. Engineered Wood, LVP, Laminate)")
    species      = args.species      or prompt("Species (Enter to skip)", "")
    width_s      = args.width        or prompt("Plank width inches (Enter to skip)", "")
    length_max_s = args.length_max   or prompt("Max plank length inches (Enter to skip)", "")
    thickness_s  = args.thickness    or prompt("Thickness inches (Enter to skip)", "")
    shade_var    = args.shade_variation or prompt("Shade variation Low/Medium/High (Enter to skip)", "")
    base_sku     = args.base_sku     or ""

    def _float(s) -> float | None:
        try:
            v = float(s)
            return v if v > 0 else None
        except (TypeError, ValueError):
            return None

    width      = _float(width_s)
    length_max = _float(length_max_s)
    thickness  = _float(thickness_s)

    out_dir = out_base / line_code
    out_dir.mkdir(parents=True, exist_ok=True)

    # ── Extract ─────────────────────────────────────────────────────────────
    with tempfile.TemporaryDirectory(prefix="flora_ingest_") as tmp:
        tmpdir = Path(tmp)

        print(f"\nExtracting images from PDF...")
        all_images = extract_images(pdf_path, tmpdir)
        print(f"  {len(all_images)} image(s) extracted total")

        print("Extracting text...")
        text = extract_text(pdf_path)
        color_candidates = find_color_candidates(text)
        print(f"  {len(color_candidates)} color candidate(s) found in text")

        swatches = filter_swatches(all_images)
        print(f"  {len(swatches)} image(s) look like swatches (size + aspect ratio)\n")

        if not swatches:
            print("No swatch-shaped images found. All extracted images:")
            for i, img in enumerate(all_images):
                w, h = png_dimensions(img)
                print(f"  [{i}] {img.name}  {w}×{h}")
            print("\nTip: check the PDF, or run pdfimages manually and rename files yourself.")
            sys.exit(1)

        # ── Interactive / batch mapping ────────────────────────────────────
        print("=== Map swatches to colorways ===")
        if not args.noninteractive:
            print("For each swatch: enter color name + SKU, or press Enter/n to skip.\n")

        colorways: list[dict] = []

        for i, img in enumerate(swatches):
            w, h = png_dimensions(img)
            sug = color_candidates[i] if i < len(color_candidates) else {}
            sug_name = sug.get("color_name", "")
            sug_sku  = sug.get("sku", "")
            sug_code = sug.get("color_code", "")

            print(f"Swatch [{i+1}/{len(swatches)}]: {img.name}  ({w}×{h})")

            if args.noninteractive:
                if not sug_name or not sug_sku:
                    print("  → Skipped (no auto-detected name/SKU)")
                    continue
                color_name = sug_name
                sku = sug_sku
                color_code = sug_code
                print(f"  → Auto: {color_name}  SKU: {sku}")
            else:
                choice = input("  Include? [Y/n]: ").strip().lower()
                if choice in ("n", "no", "skip"):
                    print("  → Skipped")
                    continue

                color_name = prompt("  Color name", sug_name)
                if not color_name:
                    print("  → Skipped (no name)")
                    continue

                if sug_sku:
                    sku = prompt("  SKU", sug_sku)
                else:
                    if not base_sku:
                        base_sku = prompt("  SKU prefix (e.g. 32700)")
                    color_code_in = prompt("  Color code (3 digits, e.g. 127)", sug_code)
                    sku = f"{base_sku}-{color_code_in}" if base_sku else color_code_in

                parts = sku.rsplit("-", 1)
                color_code = parts[-1] if len(parts) > 1 else sku

            slug = to_slug(color_name)
            dest_name = f"{line_code}-{color_code}-{slug}.png"
            dest = out_dir / dest_name
            shutil.copy2(img, dest)
            print(f"  → {dest_name}")

            colorways.append({
                "sku": sku,
                "color_code": color_code,
                "color_name": color_name,
                "texture_file": dest_name,
                "texture_px": [w, h],
            })

    # ── Write catalog.json ───────────────────────────────────────────────────
    catalog: dict = {
        "product_line": product_line,
        "line_code": line_code,
        "type": floor_type,
    }
    if species:       catalog["species"] = species
    if width:         catalog["plank_width_inches"] = width
    if length_max:    catalog["plank_length_max_inches"] = length_max
    if thickness:     catalog["thickness_inches"] = thickness
    if shade_var:     catalog["shade_variation"] = shade_var
    catalog["colorways"] = colorways

    cat_path = out_dir / "catalog.json"
    with open(cat_path, "w") as f:
        json.dump(catalog, f, indent=2)
    print(f"\n  catalog.json → {cat_path}")
    print(f"  {len(colorways)} colorway(s) ingested")

    # ── Merge into master_catalog.json ───────────────────────────────────────
    mc = load_master_catalog()
    merge_into_master(mc, catalog)
    save_master_catalog(mc)

    print(f"\n✓ Done. {line_code} ({product_line}) is in the catalog.\n")


# ── Entry point ───────────────────────────────────────────────────────────────

def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__,
        formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    parser.add_argument("pdf_path", nargs="?", help="Path to Mohawk sell-sheet PDF")
    parser.add_argument("--seed-all", action="store_true",
                        help="Bootstrap master_catalog.json from existing catalog.json files")
    parser.add_argument("--line-code",  help="Product line code (e.g. WEK80)")
    parser.add_argument("--product-line", help="Display name (e.g. 'Revwood Select')")
    parser.add_argument("--type", dest="floor_type", help="Floor type")
    parser.add_argument("--species", help="Wood species (optional)")
    parser.add_argument("--width",       help="Plank width in inches")
    parser.add_argument("--length-max",  help="Max plank length in inches")
    parser.add_argument("--thickness",   help="Thickness in inches")
    parser.add_argument("--shade-variation", help="Low / Medium / High")
    parser.add_argument("--base-sku",    help="SKU prefix before the dash, e.g. 32700")
    parser.add_argument("--out-dir", default=str(ASSETS_DIR),
                        help="Base output directory (default: visualizer-assets)")
    parser.add_argument("--noninteractive", action="store_true",
                        help="Auto-accept detected mappings, skip anything unclear")
    args = parser.parse_args()

    if args.seed_all:
        cmd_seed_all(Path(args.out_dir))
    elif args.pdf_path:
        cmd_ingest(args)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
