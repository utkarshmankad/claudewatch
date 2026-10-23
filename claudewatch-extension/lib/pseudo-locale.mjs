// Pseudo-localization: accents every letter, pads ~35% and brackets the
// string so clipping, concatenation and untranslated text are obvious.
const MAP = {
  a: 'à', b: 'ƀ', c: 'ç', d: 'ð', e: 'é', f: 'ƒ', g: 'ĝ', h: 'ĥ', i: 'î', j: 'ĵ', k: 'ķ', l: 'ļ', m: 'ɱ',
  n: 'ñ', o: 'ö', p: 'þ', q: 'ǫ', r: 'ŕ', s: 'š', t: 'ţ', u: 'û', v: 'ṽ', w: 'ŵ', x: 'ẋ', y: 'ý', z: 'ž',
  A: 'À', B: 'Ɓ', C: 'Ç', D: 'Ð', E: 'É', F: 'Ƒ', G: 'Ĝ', H: 'Ĥ', I: 'Î', J: 'Ĵ', K: 'Ķ', L: 'Ļ', M: 'Ṁ',
  N: 'Ñ', O: 'Ö', P: 'Þ', Q: 'Ǫ', R: 'Ŕ', S: 'Š', T: 'Ţ', U: 'Û', V: 'Ṽ', W: 'Ŵ', X: 'Ẋ', Y: 'Ý', Z: 'Ž',
};

// Leaves $PLACEHOLDER$ tokens and $$ untouched so chrome.i18n substitutions keep working.
export function pseudoLocalize(text) {
  const parts = text.split(/(\$[A-Za-z0-9_@]+\$|\$\$)/);
  const body = parts.map((p, i) => (i % 2 === 1 ? p : [...p].map((ch) => MAP[ch] ?? ch).join(''))).join('');
  const pad = '·'.repeat(Math.ceil(text.length * 0.35));
  return `[${body}${pad}]`;
}

export function pseudoLocalizeCatalog(catalog) {
  const out = {};
  for (const [key, entry] of Object.entries(catalog)) {
    out[key] = { ...entry, message: pseudoLocalize(entry.message) };
  }
  return out;
}
