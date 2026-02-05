import Store from 'electron-store';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { Profile, ProfileExport, ProfileMetadata, SubscriptionStatus } from '../types';

export interface DraftProfile {
  target_app: string;
  events: Profile['events'];
  success_metric: Profile['success_metric'];
  notes?: string;
  version?: number;
  created_at?: string;
  metadata?: Profile['metadata'];
  auto_tune?: Profile['auto_tune'];
}

export class ProfileStore {
  private store: Store;

  constructor() {
    this.store = new Store({ name: 'clicksmith-profiles' });
  }

  public list(): Profile[] {
    return (this.store.get('profiles', []) as Profile[]).sort((a, b) =>
      b.created_at.localeCompare(a.created_at)
    );
  }

  public get(id: string): Profile | undefined {
    return this.list().find(profile => profile.id === id);
  }

  public save(profile: Profile, subscription?: SubscriptionStatus): Profile {
    const profiles = this.list();
    const existing = profiles.find(item => item.id === profile.id);

    if (!existing && subscription?.features.maxProfiles === 3 && profiles.length >= 3) {
      throw new Error('Free tier limit reached. Upgrade to Pro for unlimited profiles.');
    }

    if (existing) {
      const createdAt = existing.metadata?.created_at ?? profile.metadata?.created_at ?? profile.created_at;
      const mergedCustom = {
        ...(existing.metadata?.custom ?? {}),
        ...(profile.metadata?.custom ?? {}),
      };
      const updatedMeta: ProfileMetadata = {
        created_at: createdAt,
        updated_at: new Date().toISOString(),
        version: profile.metadata?.version ?? existing.metadata?.version ?? profile.version,
        total_duration_ms:
          profile.metadata?.total_duration_ms ?? existing.metadata?.total_duration_ms ?? 0,
        event_count: profile.metadata?.event_count ?? profile.events.length,
        override_count:
          profile.metadata?.override_count ??
          existing.metadata?.override_count ??
          profile.events.filter(event => event.human_override).length,
        tags: profile.metadata?.tags ?? existing.metadata?.tags ?? [],
        custom: Object.keys(mergedCustom).length > 0 ? mergedCustom : undefined,
      };
      const updated = { ...existing, ...profile, metadata: updatedMeta };
      const nextProfiles = profiles.map(item => (item.id === profile.id ? updated : item));
      this.store.set('profiles', nextProfiles);
      return updated;
    }

    const nextProfiles = [{ ...profile }, ...profiles];
    this.store.set('profiles', nextProfiles);
    return profile;
  }

  public update(id: string, updates: Partial<Profile>): Profile {
    const existing = this.get(id);
    if (!existing) {
      throw new Error('Profile not found');
    }
    const updated = { ...existing, ...updates };
    this.save(updated);
    return updated;
  }

  public delete(id: string) {
    const profiles = this.list().filter(profile => profile.id !== id);
    this.store.set('profiles', profiles);
  }

  public saveDraft(draft: DraftProfile) {
    this.store.set('draft', draft);
  }

  public getDraft(): DraftProfile | null {
    return (this.store.get('draft', null) as DraftProfile | null) ?? null;
  }

  public discardDraft() {
    this.store.delete('draft');
  }

  public finalizeDraft(name: string, notes: string, tags: string[], targetApp?: string): Profile {
    const draft = this.getDraft();
    if (!draft) {
      throw new Error('No draft profile found');
    }
    const createdAt = draft.created_at ?? new Date().toISOString();
    const profile: Profile = {
      id: uuidv4(),
      name,
      target_app: targetApp ?? draft.target_app,
      created_at: createdAt,
      events: draft.events,
      success_metric: draft.success_metric,
      version: draft.version ?? 1,
      notes,
      auto_tune: draft.auto_tune,
      metadata: {
        created_at: createdAt,
        updated_at: new Date().toISOString(),
        version: draft.version ?? 1,
        total_duration_ms: draft.metadata?.total_duration_ms ?? 0,
        event_count: draft.events.length,
        override_count: draft.events.filter(event => event.human_override).length,
        tags,
      },
    };
    return profile;
  }

  public exportProfiles(filePath: string, profileIds?: string[]): ProfileExport {
    const profiles = this.list().filter(profile =>
      profileIds ? profileIds.includes(profile.id) : true
    );
    const exportPayload: ProfileExport = {
      format_version: '1.0.0',
      profiles,
      exported_at: new Date().toISOString(),
      app_version: '1.0.0',
    };
    fs.writeFileSync(filePath, JSON.stringify(exportPayload, null, 2), 'utf-8');
    return exportPayload;
  }

  public importProfiles(filePath: string): Profile[] {
    const raw = fs.readFileSync(filePath, 'utf-8');
    const data = JSON.parse(raw) as ProfileExport;
    const imported = data.profiles.map(profile => ({
      ...profile,
      id: profile.id || uuidv4(),
      created_at: profile.created_at || new Date().toISOString(),
      version: profile.version || 1,
    }));
    const existing = this.list();
    this.store.set('profiles', [...imported, ...existing]);
    return imported;
  }

  public suggestExportPath(baseDir: string, filename: string): string {
    return path.join(baseDir, filename);
  }
}
