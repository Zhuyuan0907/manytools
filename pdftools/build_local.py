#!/usr/bin/env python3
"""Prepare the offline app in local/ and pack it as dist/ZhuyuanLovePDF.zip.

Hand-written files live in local/ (index.html, viewer.html, assets/*).
This script (re)generates local/lib/ (vendored libraries) and local/data/ (pdf.js font tables as
<script>-loadable JS, because browsers block fetch() on file:// pages), then zips the folder.
Library sources: vendor/lib/ (exact pinned copies from cdnjs), vendor/cmaps, vendor/standard_fonts.
"""
import base64, json, shutil, zipfile
from pathlib import Path

ROOT = Path(__file__).resolve().parent
APP = ROOT / "local"
VENDOR = ROOT / "vendor"


def main() -> None:
    lib = APP / "lib"
    if lib.exists():
        shutil.rmtree(lib)
    lib.mkdir(parents=True)
    # pdf.worker.min.js is the main-thread fallback, loaded only if the background worker stalls
    for name in ("pdf.min.js", "pdf.worker.min.js", "pdf-lib.min.js", "pako.min.js", "UPNG.min.js"):
        shutil.copy(VENDOR / "lib" / name, lib / name)
    # The worker as a JS string: started from a Blob so it works when index.html is opened as a file.
    worker = (VENDOR / "lib" / "pdf.worker.min.js").read_text(encoding="utf-8")
    (lib / "pdf.worker.src.js").write_text("window.__PDFJS_WORKER_SRC=" + json.dumps(worker) + ";\n", encoding="utf-8")

    data = APP / "data"
    if data.exists():
        shutil.rmtree(data)
    for folder in ("cmaps", "standard_fonts"):
        (data / folder).mkdir(parents=True)
        for f in sorted((VENDOR / folder).iterdir()):
            if f.name.startswith("LICENSE"):
                continue
            key = f"{folder}/{f.name}"
            b64 = base64.b64encode(f.read_bytes()).decode()
            (data / folder / (f.name + ".js")).write_text(
                f"__pdfData.store[{json.dumps(key)}]={json.dumps(b64)};\n", encoding="utf-8")

    licenses = APP / "lib" / "LICENSES.txt"
    licenses.write_text(
        "pdf.js 3.11.174 (Apache-2.0, Mozilla), cmaps (Adobe, BSD-3-Clause), standard fonts (Foxit BSD / Liberation OFL)\n"
        "pdf-lib 1.17.1 (MIT), pako 2.1.0 (MIT/Zlib), UPNG.js 2.1.0 (MIT)\n", encoding="utf-8")

    dist = ROOT / "dist"
    dist.mkdir(exist_ok=True)
    out = dist / "ZhuyuanLovePDF.zip"
    with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as z:
        for p in sorted(APP.rglob("*")):
            if p.is_file():
                z.write(p, Path("ZhuyuanLovePDF") / p.relative_to(APP))
    print(f"wrote {out} ({out.stat().st_size:,} bytes)")


if __name__ == "__main__":
    main()
