import Store from 'electron-store';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs';
import path from 'path';
import { Profile, ProfileExport, ProfileMetadata, SubscriptionStatus } from '../types';
import { PatchStore } from './patchStore';

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
  private patchStore: PatchStore;

  constructor() {
    this.store = new Store({ name: 'clicksmith-profiles' });
    const storePath = (this.store as unknown as { path?: string }).path;
    const patchRoot =
      storePath && storePath.length > 0
        ? path.join(path.dirname(storePath), 'patches')
        : path.join(process.cwd(), '.clicksmith', 'patches');
    this.patchStore = new PatchStore(patchRoot);
  }

  public list(): Profile[] {
    return this.getRawProfiles()
      .map(profile => this.hydrateProfile(profile))
      .sort((a, b) => b.created_at.localeCompare(a.created_at));
  }

  public get(id: string): Profile | undefined {
    return this.list().find(profile => profile.id === id);
  }

  public save(profile: Profile, subscription?: SubscriptionStatus): Profile {
    const profiles = this.getRawProfiles();
    const existingIndex = profiles.findIndex(item => item.id === profile.id);
    const compacted = this.compactProfile(profile);

    if (existingIndex === -1 && subscription?.features.maxProfiles === 3 && profiles.length >= 3) {
      throw new Error('Free tier limit reached. Upgrade to Pro for unlimited profiles.');
    }

    if (existingIndex >= 0) {
      const existing = profiles[existingIndex];
      const createdAt = existing.metadata?.created_at ?? compacted.metadata?.created_at ?? compacted.created_at;
      const mergedCustom = {
        ...(existing.metadata?.custom ?? {}),
        ...(compacted.metadata?.custom ?? {}),
      };
      const updatedMeta: ProfileMetadata = {
        created_at: createdAt,
        updated_at: new Date().toISOString(),
        version: compacted.metadata?.version ?? existing.metadata?.version ?? compacted.version,
        total_duration_ms:
          compacted.metadata?.total_duration_ms ?? existing.metadata?.total_duration_ms ?? 0,
        event_count: compacted.metadata?.event_count ?? compacted.events.length,
        override_count:
          compacted.metadata?.override_count ??
          existing.metadata?.override_count ??
          compacted.events.filter(event => event.human_override).length,
        tags: compacted.metadata?.tags ?? existing.metadata?.tags ?? [],
        custom: Object.keys(mergedCustom).length > 0 ? mergedCustom : undefined,
      };
      const updated = { ...existing, ...compacted, metadata: updatedMeta };
      profiles[existingIndex] = updated;
      this.setRawProfiles(profiles);
      return this.hydrateProfile(updated);
    }

    profiles.unshift(compacted);
    this.setRawProfiles(profiles);
    return this.hydrateProfile(compacted);
  }

  public create(profile: Profile, subscription?: SubscriptionStatus): Profile {
    const profiles = this.getRawProfiles();
    if (subscription?.features.maxProfiles === 3 && profiles.length >= 3) {
      throw new Error('Free tier limit reached. Upgrade to Pro for unlimited profiles.');
    }

    const nextId = this.generateUniqueProfileIdFromRaw(profiles);
    const created = this.compactProfile({ ...profile, id: nextId });
    profiles.unshift(created);
    this.setRawProfiles(profiles);
    return this.hydrateProfile(created);
  }

  public update(id: string, updates: Partial<Profile>): Profile {
    const existing = this.get(id);
    if (!existing) {
      throw new Error('Profile not found');
    }
    const updated = { ...existing, ...updates };
    return this.save(updated);
  }

  public delete(id: string) {
    const profiles = this.getRawProfiles().filter(profile => profile.id !== id);
    this.setRawProfiles(profiles);
  }

  public saveDraft(draft: DraftProfile) {
    this.store.set('draft', this.compactDraft(draft));
  }

  public getDraft(): DraftProfile | null {
    const draft = (this.store.get('draft', null) as DraftProfile | null) ?? null;
    if (!draft) return null;
    return this.hydrateDraft(draft);
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
    return {
      id: this.generateUniqueProfileId(),
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
  }

  private generateUniqueProfileId(): string {
    return this.generateUniqueProfileIdFromRaw(this.getRawProfiles());
  }

  private generateUniqueProfileIdFromRaw(profiles: Profile[]): string {
    const existing = new Set(profiles.map(profile => profile.id));
    let id = uuidv4();
    while (existing.has(id)) {
      id = uuidv4();
    }
    return id;
  }

  public exportProfiles(filePath: string, profileIds?: string[]): ProfileExport {
    const profiles = this.list().filter(profile => (profileIds ? profileIds.includes(profile.id) : true));
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
    const imported = data.profiles.map(profile =>
      this.compactProfile({
        ...profile,
        id: profile.id || uuidv4(),
        created_at: profile.created_at || new Date().toISOString(),
        version: profile.version || 1,
      })
    );
    const existing = this.getRawProfiles();
    this.setRawProfiles([...imported, ...existing]);
    return imported.map(profile => this.hydrateProfile(profile));
  }

  public suggestExportPath(baseDir: string, filename: string): string {
    return path.join(baseDir, filename);
  }

  private getRawProfiles(): Profile[] {
    return this.store.get('profiles', []) as Profile[];
  }

  private setRawProfiles(profiles: Profile[]) {
    this.store.set('profiles', profiles);
  }

  private compactProfile(profile: Profile): Profile {
    return {
      ...profile,
      events: this.patchStore.compactEvents(profile.events),
    };
  }

  private hydrateProfile(profile: Profile): Profile {
    return {
      ...profile,
      events: this.patchStore.hydrateEvents(profile.events),
    };
  }

  private compactDraft(draft: DraftProfile): DraftProfile {
    return {
      ...draft,
      events: this.patchStore.compactEvents(draft.events),
    };
  }

  private hydrateDraft(draft: DraftProfile): DraftProfile {
    return {
      ...draft,
      events: this.patchStore.hydrateEvents(draft.events),
    };
  }
}
