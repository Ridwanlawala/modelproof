import { concat, fromHex, sha, toHex } from './bytes';

/**
 * Binary Merkle tree over chunk digests.
 *  leaf  = SHA-256(0x00 || chunkDigest)
 *  node  = SHA-256(0x01 || left || right)
 * An odd node at the end of a level is promoted unchanged (never duplicated),
 * and the 0x00/0x01 prefixes give leaf/node domain separation, so a node can
 * never be passed off as a leaf (second-preimage protection).
 */
const LEAF = new Uint8Array([0]);
const NODE = new Uint8Array([1]);

export async function merkleRoot(chunkDigestsHex: string[]): Promise<string> {
  if (chunkDigestsHex.length === 0) return toHex(await sha('SHA-256', LEAF)); // empty file
  let level = await Promise.all(chunkDigestsHex.map((h) => sha('SHA-256', concat(LEAF, fromHex(h)))));
  while (level.length > 1) {
    const next: Uint8Array[] = [];
    for (let i = 0; i < level.length; i += 2) {
      next.push(i + 1 < level.length ? await sha('SHA-256', concat(NODE, level[i], level[i + 1])) : level[i]);
    }
    level = next;
  }
  return toHex(level[0]);
}
