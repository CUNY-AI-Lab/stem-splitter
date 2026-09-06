// Reviewed scope: unported CC 2.0–4.0 and CC0/public-domain declarations.
// Unknown/ported/1.0 terms require separate review before export.
(function (root) {
  function parseLicense(value) {
    try {
      const url = new URL(value);
      if (!['https:', 'http:'].includes(url.protocol) || !['creativecommons.org', 'www.creativecommons.org'].includes(url.hostname) || url.username || url.password || url.port || url.search || url.hash) return null;
      if (/^\/publicdomain\/(zero|mark)\/1\.0\/?$/.test(url.pathname)) return 'pd';
      const match = /^\/licenses\/(by|by-sa|by-nc|by-nc-sa)\/(2\.0|2\.5|3\.0|4\.0)\/?$/.exec(url.pathname);
      return match ? match[1] : null;
    } catch { return null; }
  }
  function resolve(sources) {
    if (!sources.length) return { allowed: false, reason: 'Add a layer before recording.' };
    const terms = sources.map((source) => parseLicense(source?.licenseUrl));
    if (terms.some((term) => !term)) return { allowed: false, reason: 'A source needs reviewed reuse terms before this remix can be exported.' };
    if (terms.includes('by-sa') && terms.some((term) => term.includes('nc'))) return { allowed: false, reason: 'These sources combine ShareAlike and NonCommercial terms that cannot be shared in one remix.' };
    const license = terms.includes('by-nc-sa') ? 'by-nc-sa' : terms.includes('by-sa') ? 'by-sa'
      : terms.includes('by-nc') ? 'by-nc' : terms.includes('by') ? 'by' : 'pd';
    return { allowed: true, licenseUrl: license === 'pd' ? 'https://creativecommons.org/publicdomain/zero/1.0/' : `https://creativecommons.org/licenses/${license}/4.0/`, nonCommercial: license.includes('nc') };
  }
  root.StemRemixLicense = Object.freeze({ parseLicense, resolve });
})(globalThis);
