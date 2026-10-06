// Node unit tests need the same compiled-module import shape Wrangler supplies.
// This loader is never part of a deployment or the Workerd test harness bundle.
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
registerHooks({load(url,context,nextLoad) {
  if(url.endsWith('/vendor/mpg123-1.0.3.wasm')) {
    const bytes=readFileSync(new URL(url));
    return {format:'module',shortCircuit:true,source:`export default new WebAssembly.Module(Uint8Array.from(${JSON.stringify([...bytes])}));`};
  }
  return nextLoad(url,context);
}});
