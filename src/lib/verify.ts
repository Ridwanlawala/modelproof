import type { FileDigest } from './hash';
import type { FileEntry } from './manifest';

export interface FileCheck {
  ok: boolean;
  sizeMatch: boolean;
  sha256Match: boolean;
  merkleMatch: boolean;
  /** 0-based indexes of chunks whose hash differs (or that are missing/extra). */
  differingChunks: number[];
}

/** Compares a freshly hashed file with its manifest entry and localises any tampering to chunks. */
export function compareFile(expected: FileEntry, actual: FileDigest): FileCheck {
  const differing: number[] = [];
  if (expected.chunks) {
    const n = Math.max(expected.chunks.length, actual.chunks.length);
    for (let i = 0; i < n; i++) if (expected.chunks[i] !== actual.chunks[i]) differing.push(i);
  }
  const sizeMatch = expected.size === actual.size;
  const sha256Match = expected.sha256 === actual.sha256;
  const merkleMatch = expected.merkleRoot === actual.merkleRoot;
  return { ok: sizeMatch && sha256Match && merkleMatch && differing.length === 0, sizeMatch, sha256Match, merkleMatch, differingChunks: differing };
}

/** Human-readable byte ranges for differing chunks. */
export function chunkRanges(idx: number[], chunkSize: number, size: number): string[] {
  return idx.map((i) => `#${i} (bytes ${i * chunkSize}–${Math.max(i * chunkSize, Math.min((i + 1) * chunkSize, size) - 1)})`);
}
