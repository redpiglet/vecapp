#!/usr/bin/env python3
"""Build the static packaging configurator demo for GitHub Pages."""

import argparse
import json
from pathlib import Path
from tempfile import TemporaryDirectory

ROOT = Path(__file__).resolve().parents[1]
DEMO_CATALOG = Path(__file__).with_name("demo_catalog.json")
PUBLIC_MODELS = {"box": "public-models/n55.glb", "bag": "public-models/n21.glb"}


def build(output):
    catalog = json.loads(DEMO_CATALOG.read_text(encoding="utf-8"))
    files = {
        name: (ROOT / name).read_bytes()
        for name in ("index.html", "styles.css", "glb-model.js", "renderer.js", "app.js")
    }
    for product, model_path in PUBLIC_MODELS.items():
        spec = catalog["products"][product]
        spec["sizes"][spec["defaultSize"]]["model"]["url"] = model_path
        files[model_path] = (ROOT / model_path).read_bytes()

    files["catalog.js"] = (
        "window.PackagingCatalog = " + json.dumps(catalog, ensure_ascii=False) + ";\n"
    ).encode("utf-8")
    output.parent.mkdir(parents=True, exist_ok=True)
    with TemporaryDirectory(prefix=".pages-", dir=output.parent) as staging:
        site = Path(staging) / "site"
        for name, content in files.items():
            destination = site / name
            destination.parent.mkdir(parents=True, exist_ok=True)
            destination.write_bytes(content)
        site.rename(output)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("output", type=Path, help="New or empty directory for the published files")
    args = parser.parse_args()
    output = args.output.absolute()
    if output.is_symlink() or (output.exists() and (not output.is_dir() or any(output.iterdir()))):
        parser.error("Choose a new or empty output directory.")
    try:
        build(output)
    except (OSError, ValueError) as error:
        parser.exit(1, f"Build failed: {error}\n")
    print(f"Built GitHub Pages demo in {output}")


if __name__ == "__main__":
    main()
