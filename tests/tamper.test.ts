import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { hashBlob } from '../src/lib/hash';
import { fileEntry } from '../src/lib/manifest';
import { chunkRanges, compareFile } from '../src/lib/verify';
import { createDataItem, deepHash, generateArweaveJwk, manifestTags, serializeTags, verifyDataItem } from '../src/lib/arweave';
import { toHex } from '../src/lib/bytes';

const original = readFileSync(new URL('../public/sample/tiny-mlp.safetensors', import.meta.url));
const tampered = readFileSync(new URL('../public/sample/tiny-mlp.tampered.safetensors', import.meta.url));
const CHUNK = 16 * 1024;

describe('tamper detection (bundled sample model)', () => {
  it('an untouched file verifies', async () => {
    const d = await hashBlob(new Blob([original]), CHUNK);
    const r = compareFile(fileEntry('model', 'tiny-mlp.safetensors', d), await hashBlob(new Blob([original]), CHUNK));
    expect(r.ok).toBe(true);
    expect(r.differingChunks).toEqual([]);
  });

  it('a single changed weight is localised to its chunk', async () => {
    const expected = fileEntry('model', 'tiny-mlp.safetensors', await hashBlob(new Blob([original]), CHUNK));
    const r = compareFile(expected, await hashBlob(new Blob([tampered]), CHUNK));
    expect(r.ok).toBe(false);
    expect(r.merkleMatch).toBe(false);
    expect(r.sizeMatch).toBe(true);
    expect(r.differingChunks).toEqual([1]); // byte 25860 lives in chunk 1 (16384–32767)
    expect(chunkRanges(r.differingChunks, CHUNK, tampered.length)[0]).toBe('#1 (bytes 16384–32767)');
  });

  it('truncation is detected as size mismatch plus missing chunks', async () => {
    const expected = fileEntry('model', 'm', await hashBlob(new Blob([original]), CHUNK));
    const r = compareFile(expected, await hashBlob(new Blob([original.subarray(0, 20000)]), CHUNK));
    expect(r.sizeMatch).toBe(false);
    expect(r.differingChunks).toEqual([1, 2, 3]);
  });
});

describe('ANS-104 data item (Arweave publishing)', () => {
  it('avro tag encoding matches the reference layout', () => {
    expect(toHex(serializeTags([{ name: 'a', value: 'bc' }]))).toBe('02' + '0261' + '046263' + '00');
    expect(serializeTags([]).length).toBe(0);
  });

  it('deep hash is SHA-384 sized and order sensitive', async () => {
    const a = new Uint8Array([1]), b = new Uint8Array([2]);
    expect((await deepHash([a, b])).length).toBe(48);
    expect(toHex(await deepHash([a, b]))).not.toBe(toHex(await deepHash([b, a])));
  });

  it('signs a data item that verifies, and rejects a modified payload', async () => {
    const jwk = await generateArweaveJwk();
    const { id, raw } = await createDataItem(new TextEncoder().encode('{"hello":"arweave"}'), manifestTags('ab'.repeat(32), 'demo'), jwk);
    expect(id).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(await verifyDataItem(raw)).toBe(true);
    const bad = raw.slice(); bad[bad.length - 2] ^= 1;
    expect(await verifyDataItem(bad)).toBe(false);
  }, 60_000);
});
