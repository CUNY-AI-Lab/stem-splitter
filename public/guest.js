// Session creation is silent. The existing submission flow asks for a check
// only when the server requires one after three completed or pending splits.
(() => {
  let scriptReady;
  let verification;

  async function session(body) {
    const response = await fetch('/auth/guest', {
      method: 'POST', credentials: 'same-origin',
      headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error?.message || 'Please try again.');
    return result;
  }

  function loadWidget() {
    if (window.turnstile) return Promise.resolve();
    if (!scriptReady) scriptReady = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = 'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';
      script.async = true;
      const failed = () => { scriptReady = null; script.remove(); reject(new Error('Verification could not load. Please try again.')); };
      script.addEventListener('load', () => window.turnstile ? resolve() : failed(), { once: true });
      script.addEventListener('error', failed, { once: true });
      document.head.append(script);
    });
    return scriptReady;
  }

  window.StemGuest = {
    ensure(configuration) {
      return configuration?.enabled && configuration.canStart ? session({}) : Promise.resolve();
    },
    verify(configuration, container) {
      if (verification) return verification;
      verification = (async () => {
        if (!configuration?.siteKey || !container) throw new Error('Verification is temporarily unavailable.');
        await loadWidget();
        const widget = document.createElement('div');
        container.hidden = false;
        container.append(widget);
        let widgetId, timer;
        try {
          await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Verification timed out. Please try again.')), 120000);
            widgetId = window.turnstile.render(widget, {
              sitekey: configuration.siteKey, action: 'stem_guest', size: 'compact', appearance: 'interaction-only',
              callback: token => { session({ token }).then(resolve, reject); },
              'error-callback': () => reject(new Error('Verification could not complete. Please try again.')),
              'expired-callback': () => reject(new Error('Verification expired. Please try again.')),
            });
          });
        } finally {
          clearTimeout(timer);
          if (widgetId !== undefined) window.turnstile.remove?.(widgetId);
          widget.remove();
        }
      })().finally(() => { verification = null; });
      return verification;
    },
  };
})();
