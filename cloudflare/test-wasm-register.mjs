// Node unit tests need the same compiled-module import shape Wrangler supplies.
// This loader is never part of a deployment or the Workerd test harness bundle.
import { registerHooks } from 'node:module';
import { readFileSync } from 'node:fs';
registerHooks({load(url,context,nextLoad) {
  if(url.includes('/vendor/') && url.endsWith('.wasm')) {
    const bytes=readFileSync(new URL(url));
    return {format:'module',shortCircuit:true,source:`export default new WebAssembly.Module(Uint8Array.from(${JSON.stringify([...bytes])}));`};
  }
  return nextLoad(url,context);
}});
