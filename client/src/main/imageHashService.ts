import path from 'path';
import { Worker } from 'worker_threads';
import { computeDHash, computeSha256 } from './imageHash';

type HashResult = {
  sha256: string;
  dhash: string;
};

type PendingTask = {
  resolve: (value: HashResult) => void;
  reject: (reason?: unknown) => void;
};

type WorkerMessage =
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

const WORKER_RELATIVE_PATH = path.join('workers', 'imageHashWorker.js');

export class ImageHashService {
  private worker: Worker | null = null;
  private enabled = false;
  private taskId = 0;
  private pending = new Map<number, PendingTask>();

  constructor() {
    this.enabled =
      process.env.CLICKSMITH_HASH_WORKER !== 'off' &&
      !process.env.JEST_WORKER_ID &&
      this.tryCreateWorker();
  }

  public async compute(patch: Buffer): Promise<HashResult> {
    if (!this.enabled || !this.worker) {
      return this.computeInline(patch);
    }

    const id = ++this.taskId;
    return new Promise<HashResult>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.worker?.postMessage({ id, patch });
    });
  }

  public dispose() {
    if (this.worker) {
      this.worker.terminate().catch(() => undefined);
      this.worker = null;
    }
    this.pending.forEach(task => task.reject(new Error('hash_service_disposed')));
    this.pending.clear();
  }

  private tryCreateWorker(): boolean {
    try {
      const workerPath = path.join(__dirname, WORKER_RELATIVE_PATH);
      this.worker = new Worker(workerPath);
      this.worker.on('message', message => this.onWorkerMessage(message as WorkerMessage));
      this.worker.on('error', () => {
        this.enabled = false;
      });
      this.worker.on('exit', code => {
        if (code !== 0) {
          this.enabled = false;
        }
      });
      return true;
    } catch {
      this.worker = null;
      return false;
    }
  }

  private onWorkerMessage(message: WorkerMessage) {
    const task = this.pending.get(message.id);
    if (!task) return;
    this.pending.delete(message.id);
    if (message.ok) {
      task.resolve({ sha256: message.sha256, dhash: message.dhash });
      return;
    }
    task.reject(new Error(message.error));
  }

  private async computeInline(patch: Buffer): Promise<HashResult> {
    return {
      sha256: computeSha256(patch),
      dhash: await computeDHash(patch),
    };
  }
}
