import { sha256 } from '@noble/hashes/sha2';
import { sha, toHex } from './bytes';
import { merkleRoot } from './merkle';

export const DEFAULT_CHUNK = 4 * 1024 * 1024; // 4 MiB

export interface FileDigest {
  size: number;
  sha256: string; // whole-file SHA-256 (same value Hugging Face shows for LFS files)
  chunkSize: number;
  chunks: string[]; // SHA-256 of each chunk, hex
  merkleRoot: string;
}

/**
 * Streams a Blob/File in fixed-size chunks: only one chunk is in memory at a
 * time, so multi-GB GGUF/ONNX/safetensors files are fine.
 */
export async function hashBlob(
  blob: Blob,
  chunkSize = DEFAULT_CHUNK,
  onProgress?: (done: number, total: number) => void,
): Promise<FileDigest> {
  if (!Number.isInteger(chunkSize) || chunkSize < 1024) throw new Error('chunkSize must be an integer >= 1024');
  const whole = sha256.create();
  const chunks: string[] = [];
  for (let off = 0; off < blob.size; off += chunkSize) {
    const bytes = new Uint8Array(await blob.slice(off, Math.min(off + chunkSize, blob.size)).arrayBuffer());
    whole.update(bytes);
    chunks.push(toHex(await sha('SHA-256', bytes)));
    onProgress?.(Math.min(off + chunkSize, blob.size), blob.size);
  }
  if (blob.size === 0) onProgress?.(0, 0);
  return { size: blob.size, sha256: toHex(whole.digest()), chunkSize, chunks, merkleRoot: await merkleRoot(chunks) };
}
