import { describe, expect, it } from 'vitest';
import { concat, fromHex, sha, toHex } from '../src/lib/bytes';
import { merkleRoot } from '../src/lib/merkle';
import { hashBlob } from '../src/lib/hash';

const h = async (s: string) => toHex(await sha('SHA-256', new TextEncoder().encode(s)));
const leaf = async (hex: string) => sha('SHA-256', concat(new Uint8Array([0]), fromHex(hex)));
const node = async (a: Uint8Array, b: Uint8Array) => sha('SHA-256', concat(new Uint8Array([1]), a, b));

describe('merkle tree', () => {
  it('single leaf root is the prefixed leaf hash', async () => {
    const a = await h('a');
    expect(await merkleRoot([a])).toBe(toHex(await leaf(a)));
  });

  it('matches a hand-built 3-leaf tree (odd node promoted, not duplicated)', async () => {
    const [a, b, c] = await Promise.all(['a', 'b', 'c'].map(h));
    const expected = await node(await node(await leaf(a), await leaf(b)), await leaf(c));
    expect(await merkleRoot([a, b, c])).toBe(toHex(expected));
    // duplicating the last leaf must NOT give the same root (CVE-2012-2459 style ambiguity)
    expect(await merkleRoot([a, b, c, c])).not.toBe(await merkleRoot([a, b, c]));
  });

  it('is order sensitive and deterministic', async () => {
    const [a, b] = await Promise.all(['a', 'b'].map(h));
    expect(await merkleRoot([a, b])).toBe(await merkleRoot([a, b]));
    expect(await merkleRoot([a, b])).not.toBe(await merkleRoot([b, a]));
  });

  it('hashBlob streams chunks and whole-file sha256 matches a one-shot hash', async () => {
    const data = new Uint8Array(10_000).map((_, i) => (i * 31) & 0xff);
    const d = await hashBlob(new Blob([data]), 4096);
    expect(d.chunks).toHaveLength(3);
    expect(d.sha256).toBe(toHex(await sha('SHA-256', data)));
    expect(d.chunks[2]).toBe(toHex(await sha('SHA-256', data.slice(8192))));
    expect(d.merkleRoot).toBe(await merkleRoot(d.chunks));
  });
});
