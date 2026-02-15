import { parentPort } from 'worker_threads';
import { computeDHash, computeSha256 } from '../imageHash';

type ImageHashRequest = {
  id: number;
  patch: Buffer;
};

type ImageHashResponse =
  | {
      id: number;
      ok: true;
      sha256: string;
      dhash: string;
    }
  | {
      id: number;
      ok: false;
      error: string;
    };

if (!parentPort) {
  throw new Error('imageHashWorker must run in a worker thread');
}

parentPort.on('message', async (message: ImageHashRequest) => {
  const response: ImageHashResponse = await (async () => {
    try {
      const sha256 = computeSha256(message.patch);
      const dhash = await computeDHash(message.patch);
      return {
        id: message.id,
        ok: true,
        sha256,
        dhash,
      };
    } catch (error: unknown) {
      return {
        id: message.id,
        ok: false,
        error: error instanceof Error ? error.message : 'hash_worker_failed',
      };
    }
  })();

  parentPort?.postMessage(response);
});
