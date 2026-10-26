#!/bin/sh
# Rebuilds exiftool-13.42.js and zeroperl-1.0.10.wasm.gz in this folder. Needs Node/npm (the site itself doesn't).
#   sh exiftools/lib/build.sh
# @uswriting/exiftool runs ExifTool on zeroperl (Perl as WebAssembly). Bundled into one classic script for the
# worker, with two changes: zeroperl only fetches its WASM when it sees window+document (a worker has neither, so it
# would reach for Node's fs), and it compiles the 25 MB module again for every file (~1.5 s each).
set -e
OUT="$(cd "$(dirname "$0")" && pwd)"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
cd "$TMP"
echo '{"private":true,"type":"module"}' > package.json
npm install --silent --no-audit --no-fund @uswriting/exiftool@1.0.9 @6over3/zeroperl-ts@1.0.10 esbuild@0.24.2
echo "import { parseMetadata } from '@uswriting/exiftool'; self.ExifTool = { parseMetadata };" > entry.js
npx esbuild entry.js --bundle --format=iife --minify --target=es2020 '--external:node:*' --outfile=bundle.js --log-level=error
node - "$OUT/exiftool-13.42.js" <<'JS'
const fs = require('fs');
let s = fs.readFileSync('bundle.js', 'utf8');
const swap = (from, to) => { if (s.split(from).length !== 2) throw new Error('not found once: ' + from); s = s.replace(from, to); };
swap('typeof window<"u"&&typeof document<"u"', '!0');
swap('r=await WebAssembly.instantiate(s,i.wrapImports(e));return i.init(r.instance,e),r}',
  'm=self.__zeroperl||(self.__zeroperl=await WebAssembly.compile(s)),r={module:m,instance:await WebAssembly.instantiate(m,i.wrapImports(e))};return i.init(r.instance,e),r}');
fs.writeFileSync(process.argv[2], '/* ExifTool 13.42 (Phil Harvey; Perl Artistic License / GPL) on zeroperl, via @uswriting/exiftool 1.0.9 and @6over3/zeroperl-ts 1.0.10 (Apache-2.0). Bundled with esbuild; the WASM is fetched by the caller. See LICENSES.txt. */\n' + s);
JS
gzip -9 -n -c node_modules/@6over3/zeroperl-ts/dist/esm/zeroperl.wasm > "$OUT/zeroperl-1.0.10.wasm.gz"
ls -l "$OUT"
