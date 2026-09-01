import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  AutoTuneSettings,
  IPC_CHANNELS,
  PlaybackStatus,
  Profile,
  SubscriptionStatus,
  UserPreferences,
  ModAdapterStatus,
  WindowInfo,
} from '../types';

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

const buildDefaultRunName = () => {
  const now = new Date();
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `Run ${now.toLocaleTimeString()}.${ms}`;
};

const App: React.FC = () => {
  const ipc = window.clicksmith;
  const hasIpcBridge =
    !!ipc &&
    typeof ipc.invoke === 'function' &&
    typeof ipc.on === 'function' &&
    typeof ipc.send === 'function';
  const isOverlay = window.location.hash.includes('overlay');
  const [startupError, setStartupError] = useState<string | null>(null);
  const [recordingState, setRecordingState] = useState<'idle' | 'armed' | 'recording' | 'paused'>('idle');
  const [recordingError, setRecordingError] = useState<string | null>(null);
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
  const [billingMessage, setBillingMessage] = useState<string | null>(null);
  const [modAdapters, setModAdapters] = useState<ModAdapterStatus[]>([]);
  const [modMessage, setModMessage] = useState<string | null>(null);
  const [saveForm, setSaveForm] = useState({
    name: '',
    notes: '',
    tags: '',
    autoTune: false,
  });
  const draftRef = useRef<DraftProfile | null>(null);

  useEffect(() => {
    if (!isOverlay) return;
    document.body.classList.add('overlay-mode');
    return () => document.body.classList.remove('overlay-mode');
  }, [isOverlay]);

  const selectedProfile = useMemo(
    () => profiles.find(profile => profile.id === selectedProfileId) ?? null,
    [profiles, selectedProfileId]
  );
  const targetOptions = useMemo(() => {
    const deduped = new Map<string, WindowInfo>();
    targets.forEach(target => {
      const title = (target.title || '').trim();
      if (!title) return;
      if (title.toLowerCase() === 'screen') return;
      const key = title.toLowerCase();
      if (!deduped.has(key)) {
        deduped.set(key, target);
      }
    });
    return Array.from(deduped.values());
  }, [targets]);
  const isPlaybackBusy = playbackStatus?.state === 'playing' || playbackStatus?.state === 'paused';
  const isRecordingActive = recordingState === 'recording';
  const isRecordingArmed = recordingState === 'armed';
  const isRecordingBusy = isRecordingActive || isRecordingArmed || recordingState === 'paused';
  const recordingOverlayLabel = isRecordingActive ? 'LIVE' : isRecordingArmed ? 'ARMED' : 'REC';

  const openSaveModalForDraft = (nextDraft: DraftProfile) => {
    setDraft(nextDraft);
    setShowSaveModal(true);
    setSaveForm(prev => ({
      ...prev,
      name: buildDefaultRunName(),
      notes: '',
      tags: '',
    }));
  };

  useEffect(() => {
    if (!selectedProfileId && profiles.length > 0) {
      setSelectedProfileId(profiles[0].id);
    }
  }, [profiles, selectedProfileId]);

  useEffect(() => {
    const selectedExists =
      activeTarget === 'screen' ||
      targetOptions.some(target => target.title === activeTarget);
    if (!selectedExists) {
      setActiveTarget('screen');
    }
  }, [activeTarget, targetOptions]);

  useEffect(() => {
    if (selectedProfileId) {
      void ipc.invoke(IPC_CHANNELS.PLAYBACK_SELECT, { profileId: selectedProfileId });
    }
  }, [selectedProfileId]);

  useEffect(() => {
    draftRef.current = draft;
  }, [draft]);

  useEffect(() => {
    if (!hasIpcBridge) {
      setStartupError(
        'IPC bridge unavailable. Preload failed to load. Rebuild client and relaunch Electron.'
      );
      return;
    }

    void ipc.invoke(IPC_CHANNELS.PROFILE_LIST).then((data: Profile[]) => setProfiles(data || []));
    void ipc.invoke(IPC_CHANNELS.WINDOW_LIST).then((data: WindowInfo[]) => setTargets(data || []));
    void ipc.invoke(IPC_CHANNELS.SETTINGS_GET).then((data: any) => {
      setPreferences(data.preferences);
      setSubscription(data.subscription);
      setEulaAccepted(data.eulaAccepted);
    });
    void ipc.invoke(IPC_CHANNELS.MODS_LIST).then((data: ModAdapterStatus[]) => setModAdapters(data || []));

    ipc.on(IPC_CHANNELS.RECORDING_STATUS, (_: any, status: { state: string; error?: string }) => {
      setRecordingState(status.state);
      if (status.error) {
        setRecordingError(status.error);
      } else if (status.state === 'armed' || status.state === 'recording') {
        setRecordingError(null);
      }
    });

    ipc.on(IPC_CHANNELS.PLAYBACK_STATUS, (_: any, status: PlaybackStatus) => {
      setPlaybackStatus(status);
    });

    ipc.on(IPC_CHANNELS.RUN_COMPLETE, (_: any, payload: { draft?: DraftProfile }) => {
      if (payload?.draft) {
        openSaveModalForDraft(payload.draft);
      }
    });

    ipc.on('profile:saved', (_: any, profile: Profile) => {
      setProfiles(prev => [profile, ...prev.filter(item => item.id !== profile.id)]);
      setSelectedProfileId(profile.id);
    });

    ipc.on(IPC_CHANNELS.PROFILE_SAVE_REQUEST, () => {
      if (draftRef.current) {
        openSaveModalForDraft(draftRef.current);
      }
    });

    return () => {
      ipc.removeAllListeners(IPC_CHANNELS.RECORDING_STATUS);
      ipc.removeAllListeners(IPC_CHANNELS.PLAYBACK_STATUS);
      ipc.removeAllListeners(IPC_CHANNELS.RUN_COMPLETE);
      ipc.removeAllListeners('profile:saved');
      ipc.removeAllListeners(IPC_CHANNELS.PROFILE_SAVE_REQUEST);
    };
  }, []);

  const playbackErrorDisplay = useMemo(() => {
    const error = playbackStatus?.lastError;
    if (!error) return null;
    if (error === 'image_service_unavailable') {
      return null;
    }
    if (error === 'image_match_failed') {
      return 'SmartClick matching failed; playback is using positional fallback.';
    }
    return error;
  }, [playbackStatus?.lastError]);

  if (startupError) {
    return (
      <div className="app-shell" data-testid="startup-error">
        <section className="card" style={{ maxWidth: 760 }}>
          <div className="card-header">
            <h2>Startup Error</h2>
            <span className="hint">Renderer bootstrap failed</span>
          </div>
          <div className="inline-alert" data-testid="startup-error-message">{startupError}</div>
          <div className="profile-meta">
            Expected `window.clicksmith` from preload bridge but it was missing.
          </div>
          <div className="profile-meta">
            Run: <code>cd client && npm run build && npm run start</code>
          </div>
        </section>
      </div>
    );
  }

  const startRecording = async () => {
    setRecordingError(null);
    const result = await ipc.invoke(IPC_CHANNELS.RECORDING_START, { target: activeTarget });
    if (result?.success === false) {
      setRecordingError(result.error ?? 'record_start_failed');
    }
  };

  const stopRecording = async () => {
    const result = await ipc.invoke(IPC_CHANNELS.RECORDING_STOP);
    if (result?.success === false) {
      setRecordingError(result.error ?? 'record_stop_failed');
    }
  };

  const startPlayback = async () => {
    if (!selectedProfile) return;
    const result = await ipc.invoke(IPC_CHANNELS.PLAYBACK_START, {
      profileId: selectedProfile.id,
      target: activeTarget,
    });
    if (result?.success === false) {
      setPlaybackStatus({
        state: 'idle',
        currentEventIndex: 0,
        totalEvents: 0,
        elapsedMs: 0,
        successfulMatches: 0,
        failedMatches: 0,
        retries: 0,
        timingDrift: 0,
        lastError: result.error ?? 'playback_start_failed',
      });
    }
  };

  const stopPlayback = () => {
    ipc.invoke(IPC_CHANNELS.PLAYBACK_STOP);
  };

  const triggerTakeover = () => {
    ipc.invoke(IPC_CHANNELS.PLAYBACK_TAKEOVER);
  };

  const handleSaveDraft = async () => {
    if (!draft) return;
    const tags = saveForm.tags.split(',').map(tag => tag.trim()).filter(Boolean);
    await ipc.invoke(IPC_CHANNELS.PROFILE_SAVE_DRAFT, {
      name: saveForm.name || 'New Profile',
      notes: saveForm.notes,
      tags,
      autoTune: saveForm.autoTune ? AUTO_TUNE_DEFAULTS : { ...AUTO_TUNE_DEFAULTS, enabled: false },
    });
    setDraft(null);
    setShowSaveModal(false);
  };

  const handleDiscardDraft = async () => {
    await ipc.invoke(IPC_CHANNELS.PROFILE_DISCARD_DRAFT);
    setDraft(null);
    setShowSaveModal(false);
  };

  const handleExport = () => {
    ipc.invoke(IPC_CHANNELS.PROFILE_EXPORT);
  };

  const handleImport = () => {
    ipc.invoke(IPC_CHANNELS.PROFILE_IMPORT).then((result: any) => {
      if (result?.data) {
        setProfiles(prev => [...result.data, ...prev]);
      }
    });
  };

  const handleDeleteSelected = async () => {
    if (!selectedProfile) return;
    const confirmed = window.confirm(`Delete profile "${selectedProfile.name}"? This cannot be undone.`);
    if (!confirmed) return;
    await ipc.invoke(IPC_CHANNELS.PROFILE_DELETE, selectedProfile.id);
    const next = profiles.filter(profile => profile.id !== selectedProfile.id);
    setProfiles(next);
    setSelectedProfileId(next[0]?.id ?? null);
  };

  const acceptEula = () => {
    ipc.invoke(IPC_CHANNELS.EULA_ACCEPT, true);
    setEulaAccepted(true);
  };

  const formatBillingError = (error?: string) => {
    if (!error) {
      return 'Billing service unavailable. Start the backend or set CLICKSMITH_API_URL.';
    }
    if (error.includes('ECONNREFUSED')) {
      return 'Billing service offline. Start `backend` or set CLICKSMITH_API_URL.';
    }
    return error;
  };

  const handleUpgrade = async () => {
    setBillingMessage(null);
    const result = await ipc.invoke(IPC_CHANNELS.BILLING_CHECKOUT, { priceId: 'price_pro_monthly' });
    if (!result?.success) {
      setBillingMessage(formatBillingError(result?.error));
    }
  };

  const handleSnapPhaseChange = (value: string) => {
    if (!preferences) return;
    if (value.trim() === '') return;
    const parsed = Number.parseFloat(value);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.min(4, Math.max(-4, parsed));
    ipc
      .invoke(IPC_CHANNELS.SETTINGS_SET, {
        defaultPlaybackConfig: {
          ...preferences.defaultPlaybackConfig,
          snapPhaseMs: clamped,
        },
      })
      .then((updated: UserPreferences) => setPreferences(updated));
  };

  const handleImageSearchRadiusChange = (value: string) => {
    if (!preferences) return;
    if (value.trim() === '') return;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return;
    const clamped = Math.min(512, Math.max(32, parsed));
    ipc
      .invoke(IPC_CHANNELS.SETTINGS_SET, {
        defaultPlaybackConfig: {
          ...preferences.defaultPlaybackConfig,
          imageSearchRadius: clamped,
        },
      })
      .then((updated: UserPreferences) => setPreferences(updated));
  };

  const refreshMods = async () => {
    const data = await ipc.invoke(IPC_CHANNELS.MODS_LIST);
    setModAdapters(data || []);
  };

  const geodeAdapter = modAdapters.find(adapter => adapter.adapter.id === 'geode-geometry-dash');

  const handleModProbe = async (id: string) => {
    setModMessage(null);
    const result = await ipc.invoke(IPC_CHANNELS.MODS_PROBE, { id });
    if (!result?.success) {
      setModMessage(result?.error ?? 'Mod probe failed.');
      return;
    }
    if (result?.status) {
      setModAdapters(prev =>
        prev.map(item => (item.adapter.id === result.status.adapter.id ? result.status : item))
      );
    } else {
      await refreshMods();
    }
  };

  const handleModLaunch = async (id: string) => {
    setModMessage(null);
    const result = await ipc.invoke(IPC_CHANNELS.MODS_LAUNCH, { id });
    if (!result?.success) {
      setModMessage(result?.error ?? 'Launch failed.');
    }
  };

  const handleModDocs = async (id: string) => {
    setModMessage(null);
    const result = await ipc.invoke(IPC_CHANNELS.MODS_OPEN_DOC, { id });
    if (!result?.success) {
      setModMessage(result?.error ?? 'Unable to open instructions.');
    }
  };

  const handleModDownload = async (url?: string) => {
    if (!url) return;
    setModMessage(null);
    const result = await ipc.invoke(IPC_CHANNELS.MODS_OPEN_URL, { url });
    if (!result?.success) {
      setModMessage(result?.error ?? 'Unable to open download.');
    }
  };

  if (isOverlay) {
    return (
      <div className="overlay-root" data-testid="overlay-root">
        <div
          className="overlay-bar"
          onMouseEnter={() => ipc.send('overlay:set-interactive', true)}
          onMouseLeave={() => ipc.send('overlay:set-interactive', false)}
        >
          <div className="overlay-status">
            <span className={`dot ${isRecordingActive ? 'dot-rec-live' : isRecordingArmed ? 'dot-rec-armed' : ''}`} />
            <span className="overlay-label" data-testid="overlay-rec-label">{recordingOverlayLabel}</span>
            <span className={`dot ${isPlaybackBusy ? 'dot-play-live' : ''}`} />
            <span className="overlay-label" data-testid="overlay-play-label">PLAY</span>
          </div>
          <div className="overlay-actions">
            <button
              className="btn btn-overlay"
              data-testid="overlay-record"
              aria-label={isRecordingBusy ? 'Stop Recording' : 'Start Recording'}
              onClick={isRecordingBusy ? stopRecording : startRecording}
            >
              {isRecordingBusy ? 'Stop' : 'Rec'} F9
            </button>
            <button
              className="btn btn-overlay"
              data-testid="overlay-play"
              aria-label={isPlaybackBusy ? 'Stop Playback' : 'Start Playback'}
              onClick={isPlaybackBusy ? stopPlayback : startPlayback}
            >
              {isPlaybackBusy ? 'Stop' : 'Play'} F10
            </button>
            <button
              className="btn btn-overlay takeover"
              data-testid="overlay-takeover"
              aria-label="Takeover"
              onClick={triggerTakeover}
            >
              Takeover
            </button>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="app-shell" data-testid="app-shell">
      {!eulaAccepted && (
        <div className="modal-backdrop" data-testid="eula-modal">
          <div className="modal" role="dialog" aria-labelledby="eula-title">
            <h2 id="eula-title">Clicksmith Use Policy</h2>
            <p>
              Clicksmith is designed for lawful automation and training runs. You must not use it in any
              online or competitive service that prohibits automation. We never inject into game memory
              or modify files, and we only use OS-level input hooks.
            </p>
            <div className="modal-actions">
              <button className="btn btn-primary" data-testid="eula-accept" onClick={acceptEula}>
                I Accept and Understand
              </button>
            </div>
          </div>
        </div>
      )}

      {showSaveModal && draft && (
        <div className="modal-backdrop" data-testid="save-run-modal">
          <div className="modal" role="dialog" aria-labelledby="save-run-title">
            <h2 id="save-run-title">Save this run?</h2>
            <p>
              {draft.events.length} events captured against <strong>{draft.target_app}</strong>. Choose whether
              to keep the new sequence or discard it.
            </p>
            <div style={{ display: 'grid', gap: '10px' }}>
              <input
                className="input"
                data-testid="save-run-name"
                aria-label="Profile name"
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
              <button className="btn btn-primary" data-testid="save-run-confirm" onClick={handleSaveDraft}>
                Save Profile
              </button>
              <button className="btn btn-danger" data-testid="save-run-discard" onClick={handleDiscardDraft}>
                Discard
              </button>
            </div>
          </div>
        </div>
      )}

      <header className="topbar">
        <div className="logo">Clicksmith</div>
        <div className="topbar-actions">
          <div className={`chip ${isRecordingBusy ? 'chip-live' : ''}`} data-testid="chip-rec">
            REC · {isRecordingActive ? 'Live' : isRecordingArmed ? 'Armed' : 'Idle'}
          </div>
          <div className={`chip ${isPlaybackBusy ? 'chip-live' : ''}`} data-testid="chip-play">
            PLAY · {isPlaybackBusy ? (playbackStatus?.state === 'paused' ? 'Paused' : 'Running') : 'Ready'}
          </div>
          <div className="chip" data-testid="chip-target">TARGET · {activeTarget}</div>
          <div className="chip">{subscription?.tier.toUpperCase() ?? 'FREE'}</div>
          {subscription?.tier === 'free' && (
            <button className="btn btn-primary" onClick={handleUpgrade}>
              Upgrade
            </button>
          )}
        </div>
      </header>

      {playbackErrorDisplay && (
        <div className="inline-alert" data-testid="playback-error">Playback error: {playbackErrorDisplay}</div>
      )}

      {recordingError && <div className="inline-alert" data-testid="recording-error">Recording error: {recordingError}</div>}

      {billingMessage && <div className="inline-alert">{billingMessage}</div>}

      <main className="layout">
        <section className="card controls-card" data-testid="controls-card">
          <div className="card-header">
            <h2>Controls</h2>
            <span className="hint">Hotkeys: F9 · F10 · Auto takeover on click</span>
          </div>
          <div className="control-stack">
            <button
              className="btn btn-primary"
              data-testid="btn-record"
              aria-label={isRecordingBusy ? 'Stop Recording' : 'Start Recording'}
              onClick={isRecordingBusy ? stopRecording : startRecording}
            >
              {isRecordingBusy ? 'Stop Recording' : 'Start Recording'}
            </button>
            <button
              className="btn btn-ghost"
              data-testid="btn-play"
              aria-label={isPlaybackBusy ? 'Stop Playback' : 'Play Selected'}
              onClick={isPlaybackBusy ? stopPlayback : startPlayback}
              disabled={!selectedProfile}
            >
              {isPlaybackBusy ? 'Stop Playback' : 'Play Selected'}
            </button>
            <button className="btn btn-mint" data-testid="btn-takeover" aria-label="Takeover Now" onClick={triggerTakeover}>
              Takeover Now
            </button>
          </div>

          <div className="field">
            <span className="field-label">Target window</span>
            <select
              className="input"
              data-testid="select-target"
              aria-label="Target window"
              value={activeTarget}
              onChange={event => setActiveTarget(event.target.value)}
            >
              <option value="screen">Screen</option>
              {targetOptions.map(target => (
                <option key={target.title} value={target.title}>
                  {target.title}
                </option>
              ))}
            </select>
          </div>

          <div className="split-actions">
            <button className="btn btn-ghost" data-testid="btn-import" onClick={handleImport}>
              Import
            </button>
            <button className="btn btn-ghost" data-testid="btn-export" onClick={handleExport}>
              Export
            </button>
          </div>
        </section>

        <section className="card profiles-card" data-testid="profiles-card">
          <div className="card-header">
            <h2>Profiles</h2>
            <span className="hint">{profiles.length} saved</span>
          </div>
          <div className="card-scroll" data-testid="profile-list">
            {profiles.length === 0 && (
              <div className="profile-meta" data-testid="profile-empty">No profiles yet. Record a run to get started.</div>
            )}
            {profiles.map((profile, index) => (
              <div
                key={profile.id}
                className={`profile-card ${selectedProfileId === profile.id ? 'profile-card-active' : ''}`}
                data-testid={`profile-card-${profile.id}`}
                aria-pressed={selectedProfileId === profile.id}
                role="button"
                style={{ animationDelay: `${index * 40}ms` }}
                onClick={() => setSelectedProfileId(profile.id)}
              >
                <div className="profile-title">
                  <strong>{profile.name}</strong>
                  {selectedProfileId === profile.id && <span className="tag">Selected</span>}
                </div>
                <div className="profile-meta">
                  {profile.events.length} events · {profile.target_app}
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {profile.metadata?.tags?.map(tag => (
                    <span className="tag" key={tag}>
                      {tag}
                    </span>
                  ))}
                </div>
              </div>
            ))}
          </div>
          <div className="split-actions">
            <button className="btn btn-danger" data-testid="btn-delete-profile" onClick={handleDeleteSelected} disabled={!selectedProfile}>
              Delete
            </button>
            <button
              className="btn btn-ghost"
              onClick={isPlaybackBusy ? stopPlayback : startPlayback}
              disabled={!selectedProfile}
            >
              {isPlaybackBusy ? 'Stop' : 'Play'}
            </button>
          </div>
        </section>

        <section className="card settings-card" data-testid="settings-card">
          <div className="card-header">
            <h2>Settings</h2>
            <span className="hint">Geode + timing controls</span>
          </div>
          <div className="card-scroll">
            <div className="settings-grid">
              <label className="toggle">
                <input
                  type="checkbox"
                  data-testid="toggle-telemetry"
                  checked={preferences?.telemetryOptIn ?? false}
                  onChange={event =>
                    ipc
                      .invoke(IPC_CHANNELS.SETTINGS_SET, {
                        telemetryOptIn: event.target.checked,
                      })
                      .then((updated: UserPreferences) => setPreferences(updated))
                  }
                />
                Minimal telemetry
              </label>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={preferences?.autoTakeoverOnInput ?? true}
                  onChange={event =>
                    ipc
                      .invoke(IPC_CHANNELS.SETTINGS_SET, {
                        autoTakeoverOnInput: event.target.checked,
                      })
                      .then((updated: UserPreferences) => setPreferences(updated))
                  }
                />
                Auto takeover on click (playback)
              </label>
              <label className="toggle">
                <input
                  type="checkbox"
                  data-testid="toggle-smartclick"
                  checked={preferences?.defaultPlaybackConfig.useImageMatching ?? true}
                  onChange={event =>
                    ipc
                      .invoke(IPC_CHANNELS.SETTINGS_SET, {
                        defaultPlaybackConfig: {
                          ...preferences?.defaultPlaybackConfig,
                          useImageMatching: event.target.checked,
                        },
                      })
                      .then((updated: UserPreferences) => setPreferences(updated))
                  }
                />
                SmartClick matching
              </label>
              <label className="toggle">
                <input
                  type="checkbox"
                  data-testid="toggle-geode"
                  checked={preferences?.useModAdapter ?? false}
                  onChange={event =>
                    ipc
                      .invoke(IPC_CHANNELS.SETTINGS_SET, {
                        useModAdapter: event.target.checked,
                      })
                      .then((updated: UserPreferences) => setPreferences(updated))
                  }
                  disabled={!geodeAdapter || geodeAdapter.connection !== 'connected'}
                />
                Use Geode adapter
              </label>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={(preferences?.defaultPlaybackConfig.snapToHz ?? 240) > 0}
                  onChange={event =>
                    ipc
                      .invoke(IPC_CHANNELS.SETTINGS_SET, {
                        defaultPlaybackConfig: {
                          ...preferences?.defaultPlaybackConfig,
                          snapToHz: event.target.checked ? 240 : 0,
                        },
                      })
                      .then((updated: UserPreferences) => setPreferences(updated))
                  }
                />
                240Hz snap
              </label>
              <label className="toggle">
                <input
                  type="checkbox"
                  checked={(preferences?.defaultPlaybackConfig.snapMode ?? 'duration-lock') === 'duration-lock'}
                  onChange={event =>
                    ipc
                      .invoke(IPC_CHANNELS.SETTINGS_SET, {
                        defaultPlaybackConfig: {
                          ...preferences?.defaultPlaybackConfig,
                          snapMode: event.target.checked ? 'duration-lock' : 'nearest',
                        },
                      })
                      .then((updated: UserPreferences) => setPreferences(updated))
                  }
                />
                Lock hold to ticks
              </label>
              <label className="toggle">
                <input
                  type="checkbox"
                  data-testid="toggle-cloud-sync"
                  checked={preferences?.cloudSyncOptIn ?? false}
                  onChange={event =>
                    ipc
                      .invoke(IPC_CHANNELS.SETTINGS_SET, {
                        cloudSyncOptIn: event.target.checked,
                      })
                      .then((updated: UserPreferences) => setPreferences(updated))
                  }
                  disabled={!subscription?.features.cloudSync}
                />
                Cloud sync
              </label>
            </div>

            <div className="field">
              <span className="field-label">Tick phase offset (ms)</span>
              <input
                className="input"
                type="number"
                min={-4}
                max={4}
                step={0.1}
                value={preferences?.defaultPlaybackConfig.snapPhaseMs ?? 0}
                onChange={event => handleSnapPhaseChange(event.target.value)}
              />
            </div>

            <div className="field">
              <span className="field-label">SmartClick search radius (px)</span>
              <input
                className="input"
                type="number"
                min={32}
                max={512}
                step={8}
                value={preferences?.defaultPlaybackConfig.imageSearchRadius ?? 160}
                onChange={event => handleImageSearchRadiusChange(event.target.value)}
              />
            </div>

            <div className="profile-meta">
              SmartClick stats: {playbackStatus?.successfulMatches ?? 0} matched, {playbackStatus?.failedMatches ?? 0}{' '}
              fallback, {playbackStatus?.retries ?? 0} retries
              {playbackStatus?.lastError ? `, last: ${playbackStatus.lastError}` : ''}.
            </div>

            <div className="adapter-card">
              <div>
                <div className="adapter-title">Geode Adapter</div>
                <div className="profile-meta">
                  {geodeAdapter ? `Connection: ${geodeAdapter.connection}` : 'No adapter configured.'}
                </div>
                {geodeAdapter?.lastError && <div className="profile-meta">Last error: {geodeAdapter.lastError}</div>}
              </div>
              <div className="adapter-actions">
                <button className="btn btn-ghost" onClick={() => handleModProbe(geodeAdapter?.adapter.id ?? '')}>
                  Check
                </button>
                {geodeAdapter?.adapter.launch && (
                  <button className="btn btn-primary" onClick={() => handleModLaunch(geodeAdapter.adapter.id)}>
                    Launch
                  </button>
                )}
              </div>
            </div>
            {modMessage && <div className="profile-meta">{modMessage}</div>}
            <div className="adapter-links">
              {geodeAdapter?.adapter.install?.instructionsPath && (
                <button className="btn btn-ghost" onClick={() => handleModDocs(geodeAdapter.adapter.id)}>
                  Install Notes
                </button>
              )}
              {geodeAdapter?.adapter.install?.downloadUrl && (
                <button
                  className="btn btn-ghost"
                  onClick={() => handleModDownload(geodeAdapter.adapter.install?.downloadUrl)}
                >
                  Download
                </button>
              )}
              <button className="btn btn-ghost" onClick={refreshMods}>
                Refresh
              </button>
            </div>
          </div>
        </section>
      </main>
    </div>
  );
};

export default App;
