import React, { useEffect, useMemo, useState } from 'react';
import {
  AutoTuneSettings,
  IPC_CHANNELS,
  PlaybackStatus,
  Profile,
  SubscriptionStatus,
  UserPreferences,
  WindowInfo,
} from '../types';

const { ipcRenderer } = window.require('electron');

type DraftProfile = {
  target_app: string;
  events: Profile['events'];
  success_metric: Profile['success_metric'];
  created_at?: string;
  metadata?: Profile['metadata'];
};

const AUTO_TUNE_DEFAULTS: AutoTuneSettings = {
  enabled: true,
  generations: 2,
  populationSize: 6,
  mutationRate: 0.2,
  maxJitter: 18,
  fitnessWeights: { successRate: 1, timing: 1, smoothness: 1 },
};

const App: React.FC = () => {
  const isOverlay = window.location.hash.includes('overlay');
  const [recordingState, setRecordingState] = useState<'idle' | 'recording' | 'paused'>('idle');
  const [playbackStatus, setPlaybackStatus] = useState<PlaybackStatus | null>(null);
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [targets, setTargets] = useState<WindowInfo[]>([]);
  const [activeTarget, setActiveTarget] = useState<string>('screen');
  const [draft, setDraft] = useState<DraftProfile | null>(null);
  const [showSaveModal, setShowSaveModal] = useState(false);
  const [preferences, setPreferences] = useState<UserPreferences | null>(null);
  const [subscription, setSubscription] = useState<SubscriptionStatus | null>(null);
  const [eulaAccepted, setEulaAccepted] = useState(true);
  const [selectedProfileId, setSelectedProfileId] = useState<string | null>(null);
  const [saveForm, setSaveForm] = useState({
    name: '',
    notes: '',
    tags: '',
    autoTune: false,
  });

  const selectedProfile = useMemo(
    () => profiles.find(profile => profile.id === selectedProfileId) ?? null,
    [profiles, selectedProfileId]
  );

  useEffect(() => {
    void ipcRenderer.invoke(IPC_CHANNELS.PROFILE_LIST).then((data: Profile[]) => setProfiles(data || []));
    void ipcRenderer.invoke(IPC_CHANNELS.WINDOW_LIST).then((data: WindowInfo[]) => setTargets(data || []));
    void ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_GET).then((data: any) => {
      setPreferences(data.preferences);
      setSubscription(data.subscription);
      setEulaAccepted(data.eulaAccepted);
    });

    ipcRenderer.on(IPC_CHANNELS.RECORDING_STATUS, (_: any, status: { state: string }) => {
      setRecordingState(status.state);
    });

    ipcRenderer.on(IPC_CHANNELS.PLAYBACK_STATUS, (_: any, status: PlaybackStatus) => {
      setPlaybackStatus(status);
    });

    ipcRenderer.on(IPC_CHANNELS.RUN_COMPLETE, (_: any, payload: { draft?: DraftProfile }) => {
      if (payload?.draft) {
        setDraft(payload.draft);
        setShowSaveModal(true);
        setSaveForm(prev => ({
          ...prev,
          name: `Run ${new Date().toLocaleTimeString()}`,
          notes: '',
          tags: '',
        }));
      }
    });

    ipcRenderer.on('profile:saved', (_: any, profile: Profile) => {
      setProfiles(prev => [profile, ...prev.filter(item => item.id !== profile.id)]);
    });

    ipcRenderer.on(IPC_CHANNELS.PROFILE_SAVE_REQUEST, () => {
      if (draft) {
        setShowSaveModal(true);
      }
    });

    return () => {
      ipcRenderer.removeAllListeners(IPC_CHANNELS.RECORDING_STATUS);
      ipcRenderer.removeAllListeners(IPC_CHANNELS.PLAYBACK_STATUS);
      ipcRenderer.removeAllListeners(IPC_CHANNELS.RUN_COMPLETE);
      ipcRenderer.removeAllListeners('profile:saved');
      ipcRenderer.removeAllListeners(IPC_CHANNELS.PROFILE_SAVE_REQUEST);
    };
  }, [draft]);

  const startRecording = () => {
    ipcRenderer.invoke(IPC_CHANNELS.RECORDING_START, { target: activeTarget });
  };

  const stopRecording = () => {
    ipcRenderer.invoke(IPC_CHANNELS.RECORDING_STOP);
  };

  const startPlayback = () => {
    if (!selectedProfile) return;
    ipcRenderer.invoke(IPC_CHANNELS.PLAYBACK_START, { profileId: selectedProfile.id, target: activeTarget });
  };

  const stopPlayback = () => {
    ipcRenderer.invoke(IPC_CHANNELS.PLAYBACK_STOP);
  };

  const triggerTakeover = () => {
    ipcRenderer.invoke(IPC_CHANNELS.PLAYBACK_TAKEOVER);
  };

  const handleSaveDraft = async () => {
    if (!draft) return;
    const tags = saveForm.tags.split(',').map(tag => tag.trim()).filter(Boolean);
    await ipcRenderer.invoke(IPC_CHANNELS.PROFILE_SAVE_DRAFT, {
      name: saveForm.name || 'New Profile',
      notes: saveForm.notes,
      tags,
      autoTune: saveForm.autoTune ? AUTO_TUNE_DEFAULTS : { ...AUTO_TUNE_DEFAULTS, enabled: false },
    });
    setDraft(null);
    setShowSaveModal(false);
  };

  const handleDiscardDraft = async () => {
    await ipcRenderer.invoke(IPC_CHANNELS.PROFILE_DISCARD_DRAFT);
    setDraft(null);
    setShowSaveModal(false);
  };

  const handleExport = () => {
    ipcRenderer.invoke(IPC_CHANNELS.PROFILE_EXPORT);
  };

  const handleImport = () => {
    ipcRenderer.invoke(IPC_CHANNELS.PROFILE_IMPORT).then((result: any) => {
      if (result?.data) {
        setProfiles(prev => [...result.data, ...prev]);
      }
    });
  };

  const acceptEula = () => {
    ipcRenderer.invoke(IPC_CHANNELS.EULA_ACCEPT, true);
    setEulaAccepted(true);
  };

  const handleUpgrade = () => {
    ipcRenderer.invoke(IPC_CHANNELS.BILLING_CHECKOUT, { priceId: 'price_pro_monthly' });
  };

  if (isOverlay) {
    return (
      <div className="overlay-root">
        <div className="overlay-card">
          <div className="brand">
            <div className="brand-title">Clicksmith</div>
            <div className="brand-subtitle">Overlay Control</div>
          </div>
          <div className="overlay-actions">
            <button className="btn btn-primary" onClick={recordingState === 'recording' ? stopRecording : startRecording}>
              {recordingState === 'recording' ? 'Stop (F9)' : 'Record (F9)'}
            </button>
            <button className="btn btn-ghost" onClick={playbackStatus?.state === 'playing' ? stopPlayback : startPlayback}>
              {playbackStatus?.state === 'playing' ? 'Stop (F10)' : 'Play (F10)'}
            </button>
          </div>
          <button className="btn btn-mint takeover" onClick={triggerTakeover}>
            Takeover (F11)
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell">
      {!eulaAccepted && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>Clicksmith Use Policy</h2>
            <p>
              Clicksmith is designed for lawful automation and training runs. You must not use it in any
              online or competitive service that prohibits automation. We never inject into game memory
              or modify files, and we only use OS-level input hooks.
            </p>
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={acceptEula}>
                I Accept and Understand
              </button>
            </div>
          </div>
        </div>
      )}

      {showSaveModal && draft && (
        <div className="modal-backdrop">
          <div className="modal">
            <h2>Save this run?</h2>
            <p>
              {draft.events.length} events captured against <strong>{draft.target_app}</strong>. Choose whether
              to keep the new sequence or discard it.
            </p>
            <div style={{ display: 'grid', gap: '10px' }}>
              <input
                className="input"
                value={saveForm.name}
                placeholder="Profile name"
                onChange={event => setSaveForm(prev => ({ ...prev, name: event.target.value }))}
              />
              <input
                className="input"
                value={saveForm.tags}
                placeholder="Tags (comma separated)"
                onChange={event => setSaveForm(prev => ({ ...prev, tags: event.target.value }))}
              />
              <textarea
                className="input"
                style={{ minHeight: 80 }}
                value={saveForm.notes}
                placeholder="Notes or success context"
                onChange={event => setSaveForm(prev => ({ ...prev, notes: event.target.value }))}
              />
              <label className="pill">
                <input
                  type="checkbox"
                  checked={saveForm.autoTune}
                  onChange={event => setSaveForm(prev => ({ ...prev, autoTune: event.target.checked }))}
                  disabled={!subscription?.features.autoTune}
                />
                Auto-tune timing (Pro)
              </label>
            </div>
            <div className="modal-actions">
              <button className="btn btn-primary" onClick={handleSaveDraft}>
                Save Profile
              </button>
              <button className="btn btn-danger" onClick={handleDiscardDraft}>
                Discard
              </button>
            </div>
          </div>
        </div>
      )}

      <header className="app-header">
        <div className="brand">
          <div className="brand-title">Clicksmith</div>
          <div className="brand-subtitle">Human-in-the-loop input automation</div>
        </div>
        <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
          <div className="pill">{subscription?.tier.toUpperCase() ?? 'FREE'} Tier</div>
          {subscription?.tier === 'free' && (
            <button className="btn btn-primary" onClick={handleUpgrade}>
              Upgrade to Pro
            </button>
          )}
        </div>
      </header>

      <section className="status-row">
        <div className="status-card">
          <h3>Recording</h3>
          <strong>{recordingState === 'recording' ? 'Active' : 'Idle'}</strong>
          <div className="profile-meta">Hotkey: F9</div>
        </div>
        <div className="status-card">
          <h3>Playback</h3>
          <strong>{playbackStatus?.state === 'playing' ? 'Running' : 'Ready'}</strong>
          <div className="profile-meta">
            Drift: {playbackStatus?.timingDrift?.toFixed(1) ?? 0} ms
          </div>
        </div>
        <div className="status-card">
          <h3>Target Window</h3>
          <strong>{activeTarget}</strong>
          <div className="profile-meta">Overlay stays on top</div>
        </div>
      </section>

      <div className="grid">
        <section className="panel">
          <h2>Controls</h2>
          <div style={{ display: 'grid', gap: 10 }}>
            <button
              className="btn btn-primary"
              onClick={recordingState === 'recording' ? stopRecording : startRecording}
            >
              {recordingState === 'recording' ? 'Stop Recording' : 'Start Recording'}
            </button>
            <button
              className="btn btn-ghost"
              onClick={playbackStatus?.state === 'playing' ? stopPlayback : startPlayback}
              disabled={!selectedProfile}
            >
              {playbackStatus?.state === 'playing' ? 'Stop Playback' : 'Play Selected'}
            </button>
            <button className="btn btn-mint" onClick={triggerTakeover}>
              Takeover Now
            </button>
          </div>

          <div>
            <h3 className="profile-meta">Target window</h3>
            <select
              className="input"
              value={activeTarget}
              onChange={event => setActiveTarget(event.target.value)}
            >
              <option value="screen">Screen</option>
              {targets.map(target => (
                <option key={target.title} value={target.title}>
                  {target.title}
                </option>
              ))}
            </select>
          </div>

          <div style={{ display: 'grid', gap: 8 }}>
            <button className="btn btn-ghost" onClick={handleImport}>
              Import Profiles
            </button>
            <button className="btn btn-ghost" onClick={handleExport}>
              Export Profiles
            </button>
          </div>
        </section>

        <section className="panel">
          <h2>Profile Library</h2>
          <div className="panel-scroll">
            {profiles.length === 0 && (
              <div className="profile-meta">No profiles yet. Record a run to get started.</div>
            )}
            {profiles.map((profile, index) => (
              <div
                key={profile.id}
                className="profile-card"
                style={{ animationDelay: `${index * 60}ms` }}
                onClick={() => setSelectedProfileId(profile.id)}
              >
                <strong>{profile.name}</strong>
                <div className="profile-meta">
                  {profile.events.length} events • {profile.target_app}
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {profile.metadata?.tags?.map(tag => (
                    <span className="tag" key={tag}>
                      {tag}
                    </span>
                  ))}
                </div>
                {selectedProfileId === profile.id && <span className="pill">Selected</span>}
              </div>
            ))}
          </div>
        </section>

        <section className="panel">
          <h2>Settings</h2>
          <div className="profile-meta">
            Shortcuts: Record F9 • Play F10 • Takeover F11 • Quick Replay F12
          </div>
          <label className="pill">
            <input
              type="checkbox"
              checked={preferences?.telemetryOptIn ?? false}
              onChange={event =>
                ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, {
                  telemetryOptIn: event.target.checked,
                })
              }
            />
            Minimal telemetry (opt-in)
          </label>
          <label className="pill">
            <input
              type="checkbox"
              checked={preferences?.defaultPlaybackConfig.useImageMatching ?? true}
              onChange={event =>
                ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, {
                  defaultPlaybackConfig: {
                    ...preferences?.defaultPlaybackConfig,
                    useImageMatching: event.target.checked,
                  },
                })
              }
            />
            SmartClick image matching
          </label>
          <label className="pill">
            <input
              type="checkbox"
              checked={preferences?.cloudSyncOptIn ?? false}
              onChange={event =>
                ipcRenderer.invoke(IPC_CHANNELS.SETTINGS_SET, {
                  cloudSyncOptIn: event.target.checked,
                })
              }
              disabled={!subscription?.features.cloudSync}
            />
            Cloud sync (opt-in)
          </label>
          <div className="profile-meta">
            {subscription?.features.cloudSync ? 'Cloud sync enabled' : 'Cloud sync (Pro)'}
          </div>
        </section>
      </div>
    </div>
  );
};

export default App;
