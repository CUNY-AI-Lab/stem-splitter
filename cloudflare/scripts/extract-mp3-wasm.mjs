// Reproduce the static module from the exact installed npm pin; no network.
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';
import {writeFileSync,readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {WASMAudioDecoderCommon as Common} from '@wasm-audio-decoders/common';
const root=dirname(createRequire(import.meta.url).resolve('mpg123-decoder'));
if(JSON.parse(readFileSync(join(root,'package.json'),'utf8')).version!=='1.0.3')throw Error('Unexpected decoder version');
const {default:Wasm}=await import(join(root,'src/EmscriptenWasm.js'));
new Common();new Wasm(Common);
const bytes=await Common.inflateDynEncodeString(Wasm.wasm);
const sha256=createHash('sha256').update(bytes).digest('hex');
if(sha256!=='f0e9e8848367320ccb757e4092f0d6809668cfe38f43139d47b447151d7dff6b')throw Error('Unexpected Wasm digest');
writeFileSync(new URL('../vendor/mpg123-1.0.3.wasm',import.meta.url),bytes);
console.log(JSON.stringify({bytes:bytes.length,sha256}));
