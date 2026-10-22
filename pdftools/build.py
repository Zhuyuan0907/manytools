#!/usr/bin/env python3
"""Wrap index.html (artifact page content, no <html>/<head>) into a standalone page.

The output opens directly in a browser (double-click) or from any static host.
Usage: python3 build.py  ->  dist/pdf-compressor.html
"""
from pathlib import Path

ROOT = Path(__file__).resolve().parent
SKELETON_HEAD = (
    '<!doctype html><html lang="zh-Hant-TW"><head><meta charset="utf-8">'
    '<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">'
    '<style>:root{color-scheme:light;padding-top:env(safe-area-inset-top,0px);'
    'padding-bottom:env(safe-area-inset-bottom,0px)}body{margin:0;font:14px system-ui,sans-serif}'
    'img{max-width:100%}[hidden]{display:none!important}</style></head><body>'
)


def main() -> None:
    page = (ROOT / "index.html").read_text(encoding="utf-8")
    out_dir = ROOT / "dist"
    out_dir.mkdir(exist_ok=True)
    out = out_dir / "pdf-compressor.html"
    out.write_text(SKELETON_HEAD + page + "</body></html>\n", encoding="utf-8")
    print(f"wrote {out} ({out.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
