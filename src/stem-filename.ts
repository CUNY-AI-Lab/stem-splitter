/** A display filename; storage keys and canonical mixer channels stay stable. */
export function stemFilename(title: string, label: string): string {
  const part = (value: string, fallback: string) => {
    const clean = new TextDecoder().decode(new TextEncoder().encode(String(value)))
    .normalize('NFC')
    .replace(/\.(?:mp3|wav|flac|m4a|ogg|aiff?|aac|opus|webm)$/i, '')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/^[. ]+|[. ]+$/g, '') || fallback;
    let result = '';
    for (const char of clean) {
      if (new TextEncoder().encode(result + char).length > 100) break;
      result += char;
    }
    return result.trimEnd();
  };
  return `${part(title, 'Recording')} — ${part(label, 'Split')}.mp3`;
}

/** RFC 6266/5987: retain Unicode in filename*, with a safe ASCII fallback. */
export function downloadDisposition(value: string): string {
  const name = Array.from(new TextDecoder().decode(new TextEncoder().encode(value)).normalize('NFC')
    .replace(/[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069/\\:*?"<>|]/g, ' ')
    .replace(/\s+/g, ' ').trim().replace(/^[. ]+|[. ]+$/g, '')).slice(0, 130).join('') || 'split.mp3';
  const ascii = name.replace(/[^\x20-\x7e]/g, '_');
  const encoded = encodeURIComponent(name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
