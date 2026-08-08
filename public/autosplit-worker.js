// Keep the FFT work off the UI thread. autosplit.js is deliberately a plain
// browser/worker script so the exact classifier is shared with Node tests.
importScripts('/autosplit.js');

self.addEventListener('message', (event) => {
  try {
    const samples = new Float32Array(event.data.samples);
    const features = self.AutoSplit.extractFeatures(samples, event.data.sampleRate);
    const verdict = self.AutoSplit.chooseSplit(features);
    self.postMessage({ ok: true, features, verdict });
  } catch (error) {
    self.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : 'Audio analysis failed',
    });
  }
});
