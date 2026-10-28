#!/bin/sh
# Rebuilds exiftool-13.42.js and zeroperl-1.0.10.wasm.gz in this folder. Needs Node/npm (the site itself doesn't).
#   sh exiftools/lib/build.sh
# @uswriting/exiftool runs ExifTool on zeroperl (Perl as WebAssembly). Bundled into one classic script for the
# worker, with these changes: zeroperl only fetches its WASM when it sees window+document (a worker has neither, so
# it would reach for Node's fs); it compiles the 25 MB module again for every file (~1.5 s each); parseMetadata
# takes one file per run (Perl starting up is most of the time: ~1 s each, ~0.15 s each in a batch); and the
# interpreter's memory needs a handle (see below). worker.js loads the result as exiftool-13.42.js?v=3.
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
// several files in one run (the batch scan): options.more = [{ name, data }], all listed after the first; a file
// ExifTool can't read gets an Error tag in the JSON instead of failing the whole run
swap('r.push(n);let $=[...e.args||[]];', 'r.push(n);for(const x of e.more||[]){let p=`/${x.name}`;i.addFile(p,x.data),r.push(p)}let $=[...e.args||[]];');
swap('$.push(n);let a=await t.runFile', '$.push(n,...(e.more||[]).map(x=>`/${x.name}`));let a=await t.runFile');
swap('let m=J.toString(),c=Z.toString();if(!a.success||a.exitCode!==0)return', 'let m=J.toString(),c=Z.toString(),B=e.more&&c.trim().startsWith("[");if(B)m="";if((!a.success||a.exitCode!==0)&&!B)return');
// memory: keep the interpreter on purpose (the library holds it only weakly, so a garbage collection quietly built a
// new one with fresh memory), tell the page how big its memory got, and let the page drop it (Perl's memory grows
// with every run and never shrinks; past a limit the worker starts a new interpreter instead of using more)
swap('te=new WeakRef(e),ie=new WeakRef(t),{perl:e,fileSystem:t})', 'te=new WeakRef(e),ie=new WeakRef(t),self.__perl=e,self.__perlFs=t,{perl:e,fileSystem:t})');
swap('instance:await WebAssembly.instantiate(m,i.wrapImports(e))};return', 'instance:await WebAssembly.instantiate(m,i.wrapImports(e))};self.__perlMem=r.instance.exports.memory;return');
swap('self.ExifTool={parseMetadata:ne}', 'self.ExifTool={parseMetadata:ne,drop(){let e=self.__perl;te=ie=null,self.__perl=self.__perlFs=self.__perlMem=null;try{e&&e.dispose()}catch{}}}');
fs.writeFileSync(process.argv[2], '/* ExifTool 13.42 (Phil Harvey; Perl Artistic License / GPL) on zeroperl, via @uswriting/exiftool 1.0.9 and @6over3/zeroperl-ts 1.0.10 (Apache-2.0). Bundled with esbuild; the WASM is fetched by the caller. See LICENSES.txt. */\n' + s);
JS
gzip -9 -n -c node_modules/@6over3/zeroperl-ts/dist/esm/zeroperl.wasm > "$OUT/zeroperl-1.0.10.wasm.gz"
# libheif 1.23.5 for HEIC pictures where the browser has no decoder (assets/heic.js): libheif-js's WebAssembly
# build as it comes, the .wasm gzipped like zeroperl's
npm pack --silent libheif-js@1.23.5 > /dev/null
tar -xzf libheif-js-1.23.5.tgz
cp package/libheif-wasm/libheif.js "$OUT/libheif-1.23.5.js"
gzip -9 -n -c package/libheif-wasm/libheif.wasm > "$OUT/libheif-1.23.5.wasm.gz"
cp package/libheif-wasm/LICENSE "$OUT/libheif-LICENSE.txt"
ls -l "$OUT"
