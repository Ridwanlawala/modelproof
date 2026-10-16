import { describe, expect, it } from 'vitest';
import { buildManifest, canonicalize, exportPublicKey, fileEntry, generateSigningKey, serialize, signManifest, verifySignature } from '../src/lib/manifest';
import { hashBlob } from '../src/lib/hash';

describe('timestamps', () => {
  it('isoUtc formats epoch ms as RFC 3339 UTC', async () => {
    const { isoUtc } = await import('../src/lib/manifest');
    expect(isoUtc(0)).toBe('1970-01-01T00:00:00.000Z');
    expect(isoUtc(951782400123)).toBe('2000-02-29T00:00:00.123Z');
    expect(isoUtc(1792139463151)).toBe('2026-10-16T08:31:03.151Z');
  });
});

describe('canonicalisation', () => {
  it('sorts keys recursively, drops undefined, no whitespace', () => {
    expect(canonicalize({ b: 1, a: { d: [1, 'x', null], c: true }, z: undefined })).toBe('{"a":{"c":true,"d":[1,"x",null]},"b":1}');
  });
  it('is independent of key insertion order', () => {
    expect(canonicalize({ x: 1, y: { p: 2, q: 3 } })).toBe(canonicalize({ y: { q: 3, p: 2 }, x: 1 }));
  });
  it('rejects non-finite numbers', () => {
    expect(() => canonicalize({ a: NaN })).toThrow();
  });
});

async function sample() {
  const kp = await generateSigningKey();
  const d = await hashBlob(new Blob([new Uint8Array(5000).fill(7)]), 1024);
  const m = buildManifest({
    model: { name: 'demo', version: '1.0.0', license: 'MIT', baseModel: ' ', sourceUrl: 'https://huggingface.co/x/y' },
    files: [fileEntry('model', 'demo.gguf', d)],
    publicKey: await exportPublicKey(kp.publicKey),
    createdAt: '2026-10-16T00:00:00.000Z',
  });
  return { kp, m };
}

describe('Ed25519 manifest signing', () => {
  it('builds a manifest with the model merkle root and drops blank optional fields', async () => {
    const { m } = await sample();
    expect(m.merkleRoot).toBe(m.files[0].merkleRoot);
    expect(m.model.baseModel).toBeUndefined();
    expect(m.files[0].chunks).toHaveLength(5);
  });

  it('signature verifies, and survives a JSON round-trip with reordered keys', async () => {
    const { kp, m } = await sample();
    const s = await signManifest(m, kp.privateKey);
    expect(await verifySignature(s)).toBe(true);
    const reparsed = JSON.parse(JSON.stringify({ signature: s.signature, manifest: { ...JSON.parse(serialize(s)).manifest } }));
    expect(await verifySignature(reparsed)).toBe(true);
  });

  it('any edit to the manifest breaks the signature', async () => {
    const { kp, m } = await sample();
    const s = await signManifest(m, kp.privateKey);
    const edited = structuredClone(s);
    edited.manifest.files[0].chunks![2] = '00'.repeat(32);
    expect(await verifySignature(edited)).toBe(false);
    const relicensed = structuredClone(s);
    relicensed.manifest.model.license = 'Proprietary';
    expect(await verifySignature(relicensed)).toBe(false);
  });

  it('a signature from a different key is rejected', async () => {
    const { m } = await sample();
    const other = await generateSigningKey();
    expect(await verifySignature(await signManifest(m, other.privateKey))).toBe(false);
  });
});
