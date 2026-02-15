import Store from 'electron-store';
import { randomUUID } from 'crypto';
import { Profile } from '../types';

type SyncOperation = 'upsert' | 'delete';

type SyncOutboxEntry = {
  id: string;
  op: SyncOperation;
  profileId: string;
  profile?: Profile;
  token?: string;
  attempts: number;
  nextAttemptAt: number;
  lastError?: string;
};

const OUTBOX_KEY = 'entries';
const MAX_ATTEMPTS = 8;
const BASE_RETRY_MS = 1_000;
const MAX_RETRY_MS = 60_000;

class CloudSyncOutbox {
  private readonly store = new Store({ name: 'clicksmith-sync-outbox' });
  private timer: NodeJS.Timeout | null = null;
  private processing = false;

  public enqueueUpsert(profile: Profile, token?: string) {
    this.enqueue({
      id: randomUUID(),
      op: 'upsert',
      profileId: profile.id,
      profile,
      token,
      attempts: 0,
      nextAttemptAt: Date.now(),
    });
  }

  public enqueueDelete(profileId: string, token?: string) {
    this.enqueue({
      id: randomUUID(),
      op: 'delete',
      profileId,
      token,
      attempts: 0,
      nextAttemptAt: Date.now(),
    });
  }

  public flushNow() {
    void this.processQueue();
  }

  private enqueue(entry: SyncOutboxEntry) {
    const entries = this.getEntries();
    entries.push(entry);
    this.setEntries(entries);
    this.scheduleNext();
  }

  private async processQueue() {
    if (this.processing) return;
    this.processing = true;
    try {
      let entries = this.getEntries();
      const now = Date.now();
      const dueEntries = entries
        .filter(entry => entry.nextAttemptAt <= now)
        .sort((a, b) => a.nextAttemptAt - b.nextAttemptAt);

      for (const entry of dueEntries) {
        const ok = await this.dispatch(entry);
        entries = this.getEntries();
        const idx = entries.findIndex(item => item.id === entry.id);
        if (idx === -1) continue;

        if (ok) {
          entries.splice(idx, 1);
          this.setEntries(entries);
          continue;
        }

        const nextAttempts = entry.attempts + 1;
        const updated: SyncOutboxEntry = {
          ...entry,
          attempts: nextAttempts,
          nextAttemptAt: this.computeNextRetryAt(nextAttempts),
        };

        // Keep failed records for observability but back off heavily after max attempts.
        if (nextAttempts > MAX_ATTEMPTS) {
          updated.nextAttemptAt = Date.now() + MAX_RETRY_MS;
        }
        entries[idx] = updated;
        this.setEntries(entries);
      }
    } finally {
      this.processing = false;
      this.scheduleNext();
    }
  }

  private async dispatch(entry: SyncOutboxEntry): Promise<boolean> {
    const endpoint = process.env.CLICKSMITH_API_URL || 'http://localhost:3000';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (entry.token) {
      headers.Authorization = `Bearer ${entry.token}`;
    }

    try {
      if (entry.op === 'upsert') {
        if (!entry.profile) {
          return true;
        }
        const createResponse = await fetch(`${endpoint}/api/v1/profiles`, {
          method: 'POST',
          headers,
          body: JSON.stringify(entry.profile),
        });

        if (createResponse.ok) {
          return true;
        }

        if (createResponse.status !== 409) {
          return false;
        }

        const updateResponse = await fetch(`${endpoint}/api/v1/profiles/${entry.profileId}`, {
          method: 'PUT',
          headers,
          body: JSON.stringify(entry.profile),
        });
        return updateResponse.ok;
      }

      const deleteResponse = await fetch(`${endpoint}/api/v1/profiles/${entry.profileId}`, {
        method: 'DELETE',
        headers,
      });
      return deleteResponse.ok || deleteResponse.status === 404;
    } catch (error) {
      entry.lastError = error instanceof Error ? error.message : 'sync_failed';
      return false;
    }
  }

  private scheduleNext() {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    const entries = this.getEntries();
    if (entries.length === 0) return;

    const nextAt = entries.reduce(
      (min, entry) => Math.min(min, entry.nextAttemptAt),
      Number.POSITIVE_INFINITY
    );
    const delay = Math.max(0, nextAt - Date.now());
    this.timer = setTimeout(() => {
      void this.processQueue();
    }, delay);
  }

  private computeNextRetryAt(attempts: number): number {
    const exponential = Math.min(MAX_RETRY_MS, BASE_RETRY_MS * 2 ** Math.max(0, attempts - 1));
    const jitter = Math.floor(Math.random() * 400);
    return Date.now() + exponential + jitter;
  }

  private getEntries(): SyncOutboxEntry[] {
    return (this.store.get(OUTBOX_KEY, []) as SyncOutboxEntry[]) ?? [];
  }

  private setEntries(entries: SyncOutboxEntry[]) {
    this.store.set(OUTBOX_KEY, entries);
  }
}

const outbox = new CloudSyncOutbox();

export async function syncProfileToCloud(profile: Profile, token?: string) {
  outbox.enqueueUpsert(profile, token);
}

export async function syncProfileDeleteToCloud(profileId: string, token?: string) {
  outbox.enqueueDelete(profileId, token);
}

export async function flushCloudSyncOutbox() {
  outbox.flushNow();
}
