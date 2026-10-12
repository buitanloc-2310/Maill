function wellFormed(value) {
  const input = String(value ?? '');
  if (typeof input.toWellFormed === 'function') return input.toWellFormed();
  let output = '';
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = input.charCodeAt(i + 1);
      if (i + 1 < input.length && next >= 0xdc00 && next <= 0xdfff) output += input[i] + input[++i];
      else output += '\uFFFD';
    } else if (code >= 0xdc00 && code <= 0xdfff) output += '\uFFFD';
    else output += input[i];
  }
  return output;
}

export function safeMimeType(value) {
  const candidate = String(value || '').split(';')[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/.test(candidate)
    ? candidate
    : 'application/octet-stream';
}

export function safeMimeFilename(value) {
  const name = (wellFormed(value || 'attachment')
    .replace(/[\\/";\r\n\x00-\x1f\x7f]/g, '_').replace(/\.\./g, '_').slice(0, 180) || 'attachment');
  const ascii = name.normalize('NFKD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7e]/g, '_').replace(/[";\\]/g, '_') || 'attachment';
  const encoded = encodeURIComponent(name).replace(/['()*]/g, character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  return { ascii, parameters: `filename="${ascii}"; filename*=UTF-8''${encoded}` };
}
