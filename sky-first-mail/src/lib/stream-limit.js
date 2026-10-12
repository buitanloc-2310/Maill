/** Read a web stream into memory only while it remains within maxBytes. */
export async function readStreamBounded(stream, maxBytes) {
  if (!stream || typeof stream.getReader !== 'function') throw new TypeError('ReadableStream required.');
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) throw new RangeError('maxBytes must be a non-negative safe integer.');
  const reader = stream.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new TypeError('Stream chunks must be Uint8Array.');
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel('Stream exceeded configured size limit.').catch(() => {});
        throw Object.assign(new Error('Stream exceeds size limit.'), { status: 413 });
      }
      chunks.push(value);
    }
  } finally {
    try { reader.releaseLock(); } catch {}
  }
  const result = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; }
  return result;
}
