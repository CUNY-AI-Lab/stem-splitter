(() => {
  const target = document.getElementById('browser-transfer-entry');
  if (target && location.origin === 'https://tools.ailab.gc.cuny.edu' && window.StemPath?.base === '/stem-splitter') target.hidden = false;
})();
