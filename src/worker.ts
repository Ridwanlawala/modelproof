/// <reference lib="webworker" />
import { hashBlob } from './lib/hash';

// Hashing runs here so multi-GB files never block the UI thread.
self.onmessage = async (e: MessageEvent<{ id: number; file: Blob; chunkSize: number }>) => {
  const { id, file, chunkSize } = e.data;
  try {
    let last = 0;
    const digest = await hashBlob(file, chunkSize, (done, total) => {
      const now = performance.now();
      if (now - last > 80 || done === total) { last = now; postMessage({ id, type: 'progress', done, total }); }
    });
    postMessage({ id, type: 'done', digest });
  } catch (err) {
    postMessage({ id, type: 'error', message: (err as Error).message });
  }
};
