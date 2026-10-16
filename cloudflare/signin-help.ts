/** Recovery stays available even when the identity service is unreachable. */
export function signInHelp(next: string): Response {
  const retry = '/auth/login?next=' + encodeURIComponent(next);
  return new Response(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Stem Splitter · Sign-in help</title><link rel="stylesheet" href="/styles.css"></head><body><main class="teacher-main signin-recovery"><h1>Trouble signing in?</h1>
<p>If CUNY shows “Login Failed,” a blank page, or a screen that never finishes loading, close that failed sign-in tab, then try again here.</p>
<p class="signin-actions"><a class="account-button" href="${retry}" target="_blank" rel="noopener noreferrer">Try CUNY Login again (new tab)</a><a class="account-button" href="/">Back to Splitter</a></p>
<p>Sign-in opens in a new tab so this help page stays available. If it fails again, close that sign-in tab and return here.</p>
<ol class="signin-steps">
<li>If it fails again, open Stem Splitter in a private or incognito window and start sign-in there. Use the tool address, not the failed CUNY page’s address.</li>
<li>If the private window works, clear cookies and site data for <strong>ssologin.cuny.edu</strong> in your regular browser, then try again. You only need to clear that site.</li>
<li>If CUNY Login still fails, contact your <a href="https://www.cuny.edu/about/university-resources/tech-resources-help-desks/">campus help desk</a> or the Lab. Include the time, browser, and visible error message. Keep passwords and sign-in links private.</li>
</ol>
<p>If you started from a class invitation, reopen your original invitation in the private window.</p>
<p>Already signed in, but your Lab access is pending? Use your class invitation or <a href="https://ailab.gc.cuny.edu/request-access/">request Lab access</a>. Clearing cookies will not change your access approval.</p>
<p><a href="https://ailab.gc.cuny.edu/blog/cuny-login-sso/">Full sign-in guide and browser instructions</a> · <a href="mailto:ailab@gc.cuny.edu">Contact the Lab</a></p>
<p class="account-help">Starting sign-in again does not delete your saved splits. Guest work stays in the browser where you created it.</p>
</main></body></html>`, {headers:{'Content-Type':'text/html; charset=utf-8','Cache-Control':'private, no-store','Referrer-Policy':'no-referrer','X-Content-Type-Options':'nosniff','X-Robots-Tag':'noindex, nofollow','Content-Security-Policy':"default-src 'none'; style-src 'self'; img-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'"}});
}
