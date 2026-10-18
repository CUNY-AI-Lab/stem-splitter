import {readFileSync,writeFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
const root=new URL('../node_modules/wasm-media-encoders/',import.meta.url);
if(JSON.parse(readFileSync(new URL('package.json',root),'utf8')).version!=='0.7.0')throw Error('Unexpected encoder version');
const bytes=readFileSync(new URL('wasm/mp3.wasm',root));
const sha256=createHash('sha256').update(bytes).digest('hex');
if(sha256!=='85e81719250b9a667b1258143f689dda70e3e57a7e7c29ab0b4cef65c8f6eb9a')throw Error('Unexpected encoder digest');
writeFileSync(new URL('../vendor/lame-0.7.0.wasm',import.meta.url),bytes);
console.log(JSON.stringify({bytes:bytes.length,sha256}));
