// Bozuk Türkçe metni onar: UTF-8 baytları yanlışlıkla eski Mac (MacRoman) tablosuyla okunmuşsa
// ("beşiktaş" -> "be≈üikta≈ü") geri çevirir. Simülatör / panoya yapıştırma gibi durumlarda görülür.
// Parça parça çalışır: metinde doğru yazılmış harfler (ş, ğ...) varsa onlara dokunmaz.
const HIGH = 'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';
const BYTE = new Map([...HIGH].map((c, i) => [c, 0x80 + i]));

export function fixMojibake(s) {
  if (!s || /^[\x00-\x7f]*$/.test(s)) return s;
  const chars = [...s];
  let out = '';
  for (let i = 0; i < chars.length; i++) {
    const b = BYTE.get(chars[i]);
    const n = b >= 0xc2 && b <= 0xdf ? 1 : b >= 0xe0 && b <= 0xef ? 2 : 0;
    if (n && i + n < chars.length + 0) {
      let cp = n === 1 ? b & 0x1f : b & 0x0f, ok = true;
      for (let k = 1; k <= n; k++) { const c = BYTE.get(chars[i + k]); if (c === undefined || (c & 0xc0) !== 0x80) { ok = false; break; } cp = (cp << 6) | (c & 0x3f); }
      if (ok) { out += String.fromCodePoint(cp); i += n; continue; }
    }
    out += chars[i];
  }
  return out;
}
