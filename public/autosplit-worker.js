// Keep the FFT work off the UI thread. autosplit.js is deliberately a plain
// browser/worker script so the exact classifier is shared with Node tests.
importScripts('/autosplit.js');

self.addEventListener('message', (event) => {
  try {
    const decoded = new Float32Array(event.data.samples);
    const samples = self.AutoSplit.resample(
      decoded,
      event.data.sampleRate,
      self.AutoSplit.ANALYSIS_SAMPLE_RATE
    );
    const features = self.AutoSplit.extractFeatures(
      samples,
      self.AutoSplit.ANALYSIS_SAMPLE_RATE
    );
    const verdict = self.AutoSplit.chooseSplit(features);
    self.postMessage({ ok: true, features, verdict });
  } catch (error) {
    self.postMessage({
      ok: false,
      error: error instanceof Error ? error.message : 'Audio analysis failed',
    });
  }
});
