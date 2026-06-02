/**
 * InstrumentGeneratorPanel — UI for the @signalsandsorcery/instrument-generator plugin.
 *
 * UX mirrors DrumGeneratorPanel: add-track → prompt → generate. The LLM
 * extracts a CATEGORY (from the FS-discovered list — typically just
 * "plucks" in v0.8) and emits pitched, polyphonic MIDI. After generation
 * the plugin picks a random instrument from the matching category folder
 * and loads it on the track via host.setTrackInstrumentSampler.
 *
 * Differences from DrumGeneratorPanel (kept intentionally minimal for v0.8):
 *   - Categories list comes from `loadLibrary()` (FS discovery) rather
 *     than a hardcoded role-mapping table — adding an output folder adds
 *     a category at next activate.
 *   - LLM emits pitched notes (no flatten-to-60 step).
 *   - Sampler is multi-zone (setTrackInstrumentSampler with InstrumentZone[])
 *     rather than single-sound (setTrackDrumKit with a samplePath).
 *
 * Deferred from this panel vs the drum one:
 *   - FX drawer (skipped — TrackRow optional callbacks omitted)
 *   - Shuffle / Copy buttons (skipped likewise)
 *   - Bulk-add placeholders
 *   - Export-MIDI-as-zip
 *   - Per-track instrument drawer (the random pick is automatic)
 *   These can grow in later phases as the panel needs them.
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import type {
  PluginUIProps,
  PluginTrackHandle,
  MidiClipData,
  FxCategory,
  TrackFxDetailState,
  PluginTrackFxDetailState,
  PluginFxCategoryDetailState,
} from '@signalsandsorcery/plugin-sdk';
import { TrackRow, EMPTY_FX_DETAIL_STATE } from '@signalsandsorcery/plugin-sdk';
import { buildInstrumentSystemPrompt } from './src/instrument-system-prompt';
import { loadLibrary, pickInstrument, type InstrumentLibrary, type ResolvedInstrument } from './src/instrument-resolver';
import { parseLLMInstrumentResponse } from './src/parse-llm-response';
import { SamplePackCTACard, type SamplePackCardInfo } from '@signalsandsorcery/plugin-sdk';

type PackStatus = 'checking' | 'missing' | 'stale' | 'current';

// This plugin's sample-pack display identity. The HOST owns the volatile
// registry (exact size / sha256 / download URL / expected version) keyed by
// packId — reached via host.isSamplePackCurrent / getSamplePackRoot /
// getSamplePackInstalledVersion / startSamplePackDownload. The plugin only
// declares its own packId + the copy shown on the download CTA, so it no
// longer imports the app's shared/constants/sample-packs (W9 — no back doors).
//
// The description/sizeBytes below are a STATIC FALLBACK only — at runtime the
// panel pulls the live copy from host.getSamplePackInfo (SDK 2.12+) so the CTA
// matches whatever bundle the host actually ships. Kept current for hosts that
// predate getSamplePackInfo.
const INSTRUMENT_PACK: SamplePackCardInfo = {
  packId: 'sas-instrument-pack',
  displayName: 'Instrument Sample Library',
  description: '28 categories, ~5,475 instruments — basses, leads, keys, plucks, strings, mallets, choir & more',
  sizeBytes: 28_547_320_229,
};

const MAX_TRACKS = 16;
const ESTIMATED_GENERATION_MS = 15000;
const INSTRUMENT_ACCENT_COLOR = '#A78BFA';

interface InstrumentTrackState {
  handle: PluginTrackHandle;
  prompt: string;
  category: string;
  /** Currently-loaded instrument id (so shuffle could exclude it later) */
  loadedInstrumentId: string | null;
  loadedInstrumentName: string | null;
  /**
   * Per-track shuffle history. Set of instrumentIds the shuffle button
   * has handed back since the track was created OR since the history
   * was last reset (which happens automatically when the category's
   * pool is exhausted, so the cycle wraps and starts over). Generate
   * also wipes the history because picking a fresh random instrument
   * is a new cycle.
   */
  shuffleHistory: Set<string>;
  isGenerating: boolean;
  error: string | null;
  hasMidi: boolean;
  generationProgress: number;
  // Volume/pan/mute/solo — local state only, kept in sync with host.
  muted: boolean;
  solo: boolean;
  volume: number;
  pan: number;
  // FX drawer state (mirrors drum panel). Optimistically updated by the
  // handleFx* callbacks; reverted on host-call failure.
  fxDetailState: TrackFxDetailState;
  fxDrawerOpen: boolean;
}

export function InstrumentGeneratorPanel({
  host,
  activeSceneId,
  isAuthenticated,
  isConnected,
  onHeaderContent,
  onOpenContract,
  onExpandSelf,
  sceneContext,
}: PluginUIProps): React.ReactElement {
  const [tracks, setTracks] = useState<InstrumentTrackState[]>([]);
  const [library, setLibrary] = useState<InstrumentLibrary | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [isAddingTrack, setIsAddingTrack] = useState(false);
  const isAddingTrackRef = useRef(false);
  // Stable engine-id → DB-id map (rebuilt on load + kept in sync with tracks).
  // Scene data is keyed by the DB id, which is stable across reloads.
  const engineToDbIdRef = useRef<Map<string, string>>(new Map());
  // Per-track debounce handles for prompt saves.
  const saveTimeoutRefs = useRef<Record<string, ReturnType<typeof setTimeout>>>({});
  // Scene the last loadTracks() pass committed for, so a scene switch (or a
  // second loadTracks fired by onEngineReady) can no-op the stale pass.
  // Mirrors DrumGeneratorPanel.tracksLoadedForSceneRef.
  const tracksLoadedForSceneRef = useRef<string | null>(null);

  // Phase 1.1 (sample pack distribution): pack-status drives the empty-state
  // CTA vs the normal panel UI. Re-evaluated on mount and after every download
  // completes (via the pack:progress 'complete' event).
  const [packStatus, setPackStatus] = useState<PackStatus>('checking');
  // Live CTA copy (size/description). Seeded with the static fallback, then
  // overwritten by the host registry so it tracks the shipped bundle.
  const [packInfo, setPackInfo] = useState<SamplePackCardInfo>(INSTRUMENT_PACK);
  const refreshPackStatus = useCallback(async (): Promise<void> => {
    const isCurrent = await host.isSamplePackCurrent(INSTRUMENT_PACK.packId).catch(() => false);
    if (isCurrent) {
      setPackStatus('current');
      return;
    }
    const installed = await host
      .getSamplePackInstalledVersion(INSTRUMENT_PACK.packId)
      .catch(() => null);
    setPackStatus(installed === null ? 'missing' : 'stale');
  }, [host]);
  useEffect(() => {
    void refreshPackStatus();
    // Pull the canonical size/description from the host registry (SDK 2.12+);
    // optional-chained so older hosts simply keep the static fallback.
    void host.getSamplePackInfo?.(INSTRUMENT_PACK.packId)?.then(
      (info) => { if (info) setPackInfo(info); },
      () => {},
    );
    const unsub = host.onSamplePackProgress(INSTRUMENT_PACK.packId, (p) => {
      if (p.status === 'complete') void refreshPackStatus();
    });
    return unsub;
  }, [refreshPackStatus, host]);

  // --- Library scan (independent of track reclaim) ---
  // Only runs once the pack is current; otherwise the panel shows the CTA card
  // and the library stays null until the download completes.
  useEffect(() => {
    if (packStatus !== 'current') {
      setLibrary(null);
      setLibraryError(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const root = await host.getSamplePackRoot(INSTRUMENT_PACK.packId);
        if (!root) {
          setLibraryError('Sample pack root not available');
          return;
        }
        const lib = await loadLibrary(host, root);
        if (cancelled) return;
        setLibrary(lib);
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          setLibraryError(msg);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [host, packStatus]);

  // --- Reclaim instrument tracks on this scene ---
  // Runs on mount/scene-switch AND on host.onEngineReady() (below). The earlier
  // single-shot version raced the engine: on a project reopen, adoptSceneTracks()
  // ran while the engine still had 0 tracks loaded ("Adopted 0/4 DB rows"), so
  // only the tracks whose stale engine_track_id happened to still match got
  // rendered via getPluginTracks()'s read-only DB fallback — the rest silently
  // vanished. Re-running once the engine signals ready fixes that. Mirrors
  // DrumGeneratorPanel.loadTracks.
  const loadTracks = useCallback(async (): Promise<void> => {
    const sceneAtStart = activeSceneId;
    if (!sceneAtStart) {
      setTracks([]);
      tracksLoadedForSceneRef.current = null;
      return;
    }
    if (packStatus !== 'current') return;
    tracksLoadedForSceneRef.current = sceneAtStart;
    const isStale = (): boolean => tracksLoadedForSceneRef.current !== sceneAtStart;
    try {
      // adoptSceneTracks() rehydrates the host's ownership set (ownedTrackIds)
      // from tracks.plugin_id. Without it, generate/delete (which assertOwned)
      // throw NOT_OWNED after a reload even though getPluginTracks() still
      // renders the rows via its read-only DB fallback.
      await host.adoptSceneTracks();
      if (isStale()) return;
      const handles = await host.getPluginTracks();
      if (isStale()) return;
      // Restore per-track prompt + category from scene_data (keyed by the stable
      // DB id — engine ids change across reloads). Without this the prompt field
      // and category chip come back blank after a project reload.
      const sceneData = await host.getAllSceneData(sceneAtStart)
        .catch(() => ({} as Record<string, unknown>)) as Record<string, unknown>;
      if (isStale()) return;

      const idMap = new Map<string, string>();
      for (const h of handles) idMap.set(h.id, h.dbId);
      engineToDbIdRef.current = idMap;

      const trackStates: InstrumentTrackState[] = [];
      for (const handle of handles) {
        const promptKey = `track:${handle.dbId}:prompt`;
        const categoryKey = `track:${handle.dbId}:category`;
        const prompt = typeof sceneData[promptKey] === 'string'
          ? sceneData[promptKey] as string
          : '';
        // Category falls back to handle.role (persisted via setTrackRole at
        // generate-time) so the chip survives even when scene_data is absent.
        const category = typeof sceneData[categoryKey] === 'string'
          ? sceneData[categoryKey] as string
          : (handle.role ?? '');

        // Restore runtime state + MIDI presence from the engine/DB. hasMidi
        // gates the shuffle/copy/instrument buttons in TrackRow — without it a
        // reloaded (already-generated) track renders with its controls greyed
        // out and looks "inactive". Self-heal from role for rows the DB hasn't
        // flagged with MIDI yet. Mirrors DrumGeneratorPanel.loadTracks.
        let muted = false;
        let solo = false;
        let volume = 0.75;
        let pan = 0;
        let hasMidi = false;
        try {
          const info = await host.getTrackInfo(handle.id);
          muted = info.muted;
          solo = info.soloed;
          volume = info.volume;
          pan = info.pan;
          hasMidi = info.hasMidi;
        } catch {
          // Non-fatal — keep defaults.
        }
        if (!hasMidi && handle.role) hasMidi = true;

        trackStates.push({
          handle,
          prompt,
          category,
          loadedInstrumentId: null,
          loadedInstrumentName: null,
          isGenerating: false,
          error: null,
          hasMidi,
          generationProgress: 0,
          muted,
          solo,
          volume,
          pan,
          fxDetailState: { ...EMPTY_FX_DETAIL_STATE },
          fxDrawerOpen: false,
          shuffleHistory: new Set<string>(),
        });
      }
      if (isStale()) return;
      setTracks(trackStates);
    } catch (err) {
      console.error('[InstrumentGeneratorPanel] Failed to load tracks:', err);
    }
  }, [host, activeSceneId, packStatus]);

  useEffect(() => {
    void loadTracks();
  }, [loadTracks]);

  // Re-adopt when the engine finishes (re)loading a project. On reopen the
  // engine populates its track list asynchronously, so the initial loadTracks()
  // above can run before any engine tracks exist. Mirrors DrumGeneratorPanel.
  useEffect(() => {
    const unsub = host.onEngineReady(() => { void loadTracks(); });
    return unsub;
  }, [host, loadTracks]);

  // Keep the engine-id → DB-id map current as tracks are added/removed so
  // prompt saves (keyed by DB id) resolve for freshly-added tracks too.
  useEffect(() => {
    const map = new Map<string, string>();
    for (const t of tracks) map.set(t.handle.id, t.handle.dbId);
    engineToDbIdRef.current = map;
  }, [tracks]);

  const availableCategories = useMemo<string[]>(
    () => library?.categories ?? [],
    [library],
  );

  const needsContract = !sceneContext?.hasContract;

  // --- Add Track ---
  // Declared above the header useEffect because the effect depends on this
  // callback as a stable handler for the header's "+ Add" button.
  const handleAddTrack = useCallback(async (): Promise<void> => {
    if (isAddingTrackRef.current) return;
    if (!isConnected) {
      host.showToast('warning', 'Systems not connected');
      return;
    }
    if (!isAuthenticated) {
      host.showToast('warning', 'Sign In Required', 'Please sign in to add tracks');
      return;
    }
    if (tracks.length >= MAX_TRACKS) return;
    if (availableCategories.length === 0) {
      host.showToast('warning', 'Empty library', 'No instruments found in the installed pack.');
      return;
    }

    isAddingTrackRef.current = true;
    setIsAddingTrack(true);
    try {
      // Track is silent until the user types a prompt + clicks Generate.
      // After generation the sampler is loaded with a random instrument
      // from the LLM-chosen category via host.setTrackInstrumentSampler.
      const handle = await host.createTrack({
        name: `instrument-${Date.now()}`,
      });
      setTracks(prev => [...prev, {
        handle,
        prompt: '',
        category: '',
        loadedInstrumentId: null,
        loadedInstrumentName: null,
        isGenerating: false,
        error: null,
        hasMidi: false,
        generationProgress: 0,
        muted: false,
        solo: false,
        volume: 0.75,
        pan: 0,
        fxDetailState: { ...EMPTY_FX_DETAIL_STATE },
        fxDrawerOpen: false,
        shuffleHistory: new Set<string>(),
      }]);
      onExpandSelf?.();
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      host.showToast('error', 'Failed to create track', msg);
    } finally {
      isAddingTrackRef.current = false;
      setIsAddingTrack(false);
    }
  }, [host, tracks.length, isConnected, isAuthenticated, availableCategories, onExpandSelf]);

  // --- Header content: "+ Add" button rendered up in the accordion strip.
  // Mirrors drum-generator's pattern. When no contract exists the button
  // bounces the user to the Contract section instead of trying to add a
  // track (which would generate nothing useful without contract context).
  useEffect(() => {
    if (!onHeaderContent) return;
    // Phase 1.1: hide "+ Add" until the sample pack is installed — the
    // panel body shows a CTA card in that state and adding tracks would
    // produce silent ones.
    if (packStatus !== 'current') {
      onHeaderContent(null);
      return () => { onHeaderContent(null); };
    }
    const addDisabled =
      needsContract
      || !isConnected
      || !activeSceneId
      || tracks.length >= MAX_TRACKS
      || isAddingTrack
      || availableCategories.length === 0;

    onHeaderContent(
      <div className="flex gap-1">
        <button
          data-testid="add-instrument-track-button"
          onClick={(e: React.MouseEvent) => {
            e.stopPropagation();
            if (needsContract) { onOpenContract?.(); return; }
            handleAddTrack();
          }}
          className={`px-2 py-0.5 text-[10px] font-medium rounded-sm border transition-colors ${
            addDisabled
              ? 'bg-sas-panel border-sas-border text-sas-muted/50 cursor-not-allowed'
              : 'bg-sas-accent/10 border-sas-accent/30 text-sas-accent hover:bg-sas-accent/20'
          }`}
          title={
            !activeSceneId ? 'Select a scene first'
              : needsContract ? 'Generate a contract first'
              : availableCategories.length === 0 ? 'Empty instrument library'
              : tracks.length >= MAX_TRACKS ? `Track limit (${MAX_TRACKS}) reached`
              : 'Create a new instrument track'
          }
        >
          + Add
        </button>
      </div>
    );
    return () => { onHeaderContent(null); };
  }, [onHeaderContent, sceneContext, isConnected, isAddingTrack, packStatus,
      needsContract, activeSceneId, tracks.length, availableCategories.length,
      handleAddTrack, onOpenContract]);

  // --- Per-track state updates ---
  const updateTrack = useCallback((trackId: string, patch: Partial<InstrumentTrackState>) => {
    setTracks(prev => prev.map(t => t.handle.id === trackId ? { ...t, ...patch } : t));
  }, []);

  const handlePromptChange = useCallback((trackId: string, prompt: string): void => {
    updateTrack(trackId, { prompt });
    // Persist debounced to scene_data so the prompt survives reload. Keyed by
    // the stable DB id, per the drum panel's pattern.
    if (!activeSceneId) return;
    const dbId = engineToDbIdRef.current.get(trackId) ?? trackId;
    if (saveTimeoutRefs.current[trackId]) clearTimeout(saveTimeoutRefs.current[trackId]);
    saveTimeoutRefs.current[trackId] = setTimeout(() => {
      host.setSceneData(activeSceneId, `track:${dbId}:prompt`, prompt).catch(() => {});
    }, 500);
  }, [updateTrack, host, activeSceneId]);

  const handleDeleteTrack = useCallback(async (trackId: string): Promise<void> => {
    try {
      const dbId = engineToDbIdRef.current.get(trackId) ?? trackId;
      await host.deleteTrack(trackId);
      if (activeSceneId) {
        // Clean up persisted prompt/category for the deleted track.
        await host.deleteSceneData(activeSceneId, `track:${dbId}:prompt`).catch(() => {});
        await host.deleteSceneData(activeSceneId, `track:${dbId}:category`).catch(() => {});
      }
      setTracks(prev => prev.filter(t => t.handle.id !== trackId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      host.showToast('error', 'Failed to delete track', msg);
    }
  }, [host, activeSceneId]);

  const handleMuteToggle = useCallback(async (trackId: string): Promise<void> => {
    const t = tracks.find(t => t.handle.id === trackId);
    if (!t) return;
    const next = !t.muted;
    updateTrack(trackId, { muted: next });
    try { await host.setTrackMute(trackId, next); } catch { /* leave UI optimistic */ }
  }, [host, tracks, updateTrack]);

  const handleSoloToggle = useCallback(async (trackId: string): Promise<void> => {
    const t = tracks.find(t => t.handle.id === trackId);
    if (!t) return;
    const next = !t.solo;
    updateTrack(trackId, { solo: next });
    try { await host.setTrackSolo(trackId, next); } catch { /* */ }
  }, [host, tracks, updateTrack]);

  const handleVolumeChange = useCallback(async (trackId: string, volume: number): Promise<void> => {
    updateTrack(trackId, { volume });
    try { await host.setTrackVolume(trackId, volume); } catch { /* */ }
  }, [host, updateTrack]);

  const handlePanChange = useCallback(async (trackId: string, pan: number): Promise<void> => {
    updateTrack(trackId, { pan });
    try { await host.setTrackPan(trackId, pan); } catch { /* */ }
  }, [host, updateTrack]);

  // --- FX drawer + per-category controls ---
  // Lifted verbatim from DrumGeneratorPanel.tsx (~lines 698-751); shape is
  // generic — no drum-specific bits — so it ports cleanly. Pattern is
  // optimistic local update, then host call, then revert on failure.
  const handleFxToggle = useCallback((trackId: string, category: FxCategory, enabled: boolean): void => {
    setTracks(prev => prev.map(t =>
      t.handle.id === trackId
        ? { ...t, fxDetailState: { ...t.fxDetailState, [category]: { ...t.fxDetailState[category], enabled } } }
        : t
    ));
    host.toggleTrackFx(trackId, category, enabled).catch(() => {
      setTracks(prev => prev.map(t =>
        t.handle.id === trackId
          ? { ...t, fxDetailState: { ...t.fxDetailState, [category]: { ...t.fxDetailState[category], enabled: !enabled } } }
          : t
      ));
    });
  }, [host]);

  const handleFxPresetChange = useCallback((trackId: string, category: FxCategory, presetIndex: number): void => {
    setTracks(prev => prev.map(t =>
      t.handle.id === trackId
        ? { ...t, fxDetailState: { ...t.fxDetailState, [category]: { ...t.fxDetailState[category], presetIndex } } }
        : t
    ));
    host.setTrackFxPreset(trackId, category, presetIndex).then(result => {
      if (result.dryWet !== undefined) {
        setTracks(prev => prev.map(t =>
          t.handle.id === trackId
            ? { ...t, fxDetailState: { ...t.fxDetailState, [category]: { ...t.fxDetailState[category], dryWet: result.dryWet as number } } }
            : t
        ));
      }
    }).catch(() => {});
  }, [host]);

  const handleFxDryWetChange = useCallback((trackId: string, category: FxCategory, value: number): void => {
    setTracks(prev => prev.map(t =>
      t.handle.id === trackId
        ? { ...t, fxDetailState: { ...t.fxDetailState, [category]: { ...t.fxDetailState[category], dryWet: value } } }
        : t
    ));
    host.setTrackFxDryWet(trackId, category, value).catch(() => {});
  }, [host]);

  const toggleFxDrawer = useCallback((trackId: string): void => {
    // Toggle the drawer's open state and, when opening, lazily fetch the
    // current FX state from the engine so the drawer renders accurate
    // preset/dry-wet values rather than the EMPTY_FX_DETAIL_STATE
    // placeholder the track was created with.
    setTracks(prev => prev.map(t =>
      t.handle.id === trackId ? { ...t, fxDrawerOpen: !t.fxDrawerOpen } : t
    ));
    const track = tracks.find(t => t.handle.id === trackId);
    if (track && !track.fxDrawerOpen) {
      host.getTrackFxState(trackId).then(fxState => {
        setTracks(prev => prev.map(t =>
          t.handle.id === trackId ? { ...t, fxDetailState: pluginFxToToggleFx(fxState) } : t
        ));
      }).catch(() => {});
    }
  }, [host, tracks]);

  // --- Duplicate track: new instance with the same MIDI + same instrument/sample.
  // Mirrors DrumGeneratorPanel.handleCopy. host.duplicateTrack copies the MIDI
  // clips and the sampler state; loadTracks restores the copy's category from
  // its role, so the Shuffle button below works on the copy — that's how the
  // user thickens the sound (copy, then shuffle the copy to a different sample).
  const handleCopy = useCallback(async (trackId: string): Promise<void> => {
    try {
      const newHandle = await host.duplicateTrack(trackId);
      await loadTracks();
      host.showToast('success', 'Track duplicated', newHandle.name);
    } catch (error: unknown) {
      const msg = error instanceof Error ? error.message : 'Copy failed';
      host.showToast('error', 'Copy failed', msg);
    }
  }, [host, loadTracks]);

  // --- Shuffle: swap the loaded instrument for a different one in the same category ---
  // Mirrors DrumGeneratorPanel.tsx:660. Only meaningful after Generate has populated
  // track.category; TrackRow gates the button on hasMidi so this is safe to wire
  // unconditionally — the button hides until a generation has run.
  const handleShuffle = useCallback(async (trackId: string): Promise<void> => {
    const track = tracks.find(t => t.handle.id === trackId);
    if (!track || !library) return;
    const category = track.category;
    if (!category) {
      host.showToast('warning', 'Shuffle skipped', 'Generate first to set the category');
      return;
    }

    // Cycle pattern: each shuffle picks from { pool - history }. When the
    // filtered pool is empty we've cycled through every instrument in the
    // category — reset history and try again with a fresh deck. Use the
    // resulting Set to update track state so the next shuffle excludes the
    // current pick too.
    const history = track.shuffleHistory;
    let picked = pickInstrument(library, category, history);
    let nextHistory: Set<string>;
    if (!picked) {
      // Exhausted — wrap the deck and re-pick from full pool
      nextHistory = new Set<string>();
      picked = pickInstrument(library, category, nextHistory);
    } else {
      nextHistory = new Set(history);
    }
    if (!picked) {
      host.showToast('warning', 'Shuffle skipped', `No instruments available in "${category}"`);
      return;
    }
    nextHistory.add(picked.instrumentId);

    try {
      await host.setTrackInstrumentSampler(trackId, {
        name: picked.displayName,
        zones: picked.zones,
      });
      updateTrack(trackId, {
        loadedInstrumentId: picked.instrumentId,
        loadedInstrumentName: picked.displayName,
        shuffleHistory: nextHistory,
      });
      console.log(
        `[InstrumentGeneratorPanel] shuffle: track ${trackId} → "${picked.displayName}" (${picked.instrumentId}); history ${nextHistory.size}/${library.byCategory.get(category)?.length ?? '?'}; zone[0]=${picked.zones[0]?.samplePath}`
      );
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Shuffle failed';
      host.showToast('error', 'Shuffle failed', msg);
    }
  }, [host, tracks, library, updateTrack]);

  // --- Generate: prompt → LLM → MIDI + sampler load ---
  const handleGenerate = useCallback(async (trackId: string): Promise<void> => {
    const track = tracks.find(t => t.handle.id === trackId);
    if (!track || !track.prompt.trim()) return;
    if (!isAuthenticated) {
      host.showToast('warning', 'Sign In Required', 'Please sign in to generate MIDI');
      return;
    }
    if (!library || availableCategories.length === 0) {
      host.showToast('warning', 'Empty library', 'Cannot generate without instruments.');
      return;
    }

    updateTrack(trackId, { isGenerating: true, error: null, generationProgress: 0 });

    try {
      const musicalContext = await host.getMusicalContext();

      const userPrompt = `User request: "${track.prompt}"\n\nGenerate a pitched MIDI clip for a sample-based instrument that fits this context.`;

      const llmResult = await host.generateWithLLM({
        system: buildInstrumentSystemPrompt(availableCategories),
        user: userPrompt,
        responseFormat: 'json',
      });

      const parsed = parseLLMInstrumentResponse(llmResult.content);
      if (!parsed || parsed.notes.length === 0) {
        throw new Error('LLM returned no valid notes');
      }

      // Pitched notes — no flatten step (the drum plugin's flatten-to-60
      // is a drum-specific hack, irrelevant here). Keep removeOverlaps
      // off too: the sampler is voice-allocated polyphonic, so chords
      // with overlapping notes are intentional.
      const processedNotes = await host.postProcessMidi(parsed.notes, {
        quantize: false,
        removeOverlaps: false,
      });

      const clipData: MidiClipData = {
        startTime: 0,
        endTime: (musicalContext.bars * 4 * 60) / musicalContext.bpm,
        tempo: musicalContext.bpm,
        notes: processedNotes,
      };
      await host.writeMidiClip(trackId, clipData);

      // Resolve the LLM's category back to one we actually have. Fall back
      // to the first available category if the LLM hallucinated.
      const requestedCategory = parsed.category ?? '';
      const chosenCategory = availableCategories.includes(requestedCategory)
        ? requestedCategory
        : availableCategories[0];

      // Persist the chosen category as the track role so downstream UI
      // (FX defaults, contract-aware features, future plugins) can scope by
      // category. Mirrors the drum plugin's setTrackRole call after MIDI
      // is committed. Without this the tracks row stores role='' and the
      // engine treats the track as a generic synth (which can route to the
      // default Surge XT instead of the sampler we just loaded).
      if (chosenCategory && chosenCategory !== track.category) {
        try {
          await host.setTrackRole(trackId, chosenCategory);
        } catch (err) {
          console.warn('[InstrumentGeneratorPanel] setTrackRole failed:', err);
        }
      }
      // Persist category to scene_data (keyed by the stable DB id) so the
      // category chip is restored on reload alongside the prompt.
      if (activeSceneId && chosenCategory) {
        const genDbId = engineToDbIdRef.current.get(trackId) ?? trackId;
        host.setSceneData(activeSceneId, `track:${genDbId}:category`, chosenCategory).catch(() => {});
      }

      // Pick a random instrument from the matching category and load it.
      const picked = pickInstrument(library, chosenCategory);
      let loadedInstrumentId = track.loadedInstrumentId;
      let loadedInstrumentName = track.loadedInstrumentName;
      if (picked) {
        try {
          await host.setTrackInstrumentSampler(trackId, {
            name: picked.displayName,
            zones: picked.zones,
          });
          loadedInstrumentId = picked.instrumentId;
          loadedInstrumentName = picked.displayName;
          // Diagnostic — surfaces which sample file backed this generation so
          // "I think it sounds wrong" complaints can be checked against the
          // actual WAV on disk.
          console.log(
            `[InstrumentGeneratorPanel] track ${trackId} → category="${chosenCategory}", instrument="${picked.displayName}" (${picked.instrumentId}), zone[0]=${picked.zones[0]?.samplePath}`
          );
        } catch (err) {
          console.warn('[InstrumentGeneratorPanel] setTrackInstrumentSampler failed:', err);
        }
      }

      // Generate starts a new shuffle cycle — seed history with the newly
      // picked instrument so the next shuffle won't return the same one.
      const freshHistory = new Set<string>();
      if (loadedInstrumentId) freshHistory.add(loadedInstrumentId);
      updateTrack(trackId, {
        isGenerating: false,
        error: null,
        category: chosenCategory,
        loadedInstrumentId,
        loadedInstrumentName,
        hasMidi: true,
        generationProgress: 0,
        shuffleHistory: freshHistory,
      });
      host.showToast('success', `Generated · ${chosenCategory} · ${loadedInstrumentName ?? '—'}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Generation failed';
      updateTrack(trackId, { isGenerating: false, error: msg, generationProgress: 0 });
      host.showToast('error', 'Generation failed', msg);
    }
  }, [host, tracks, isAuthenticated, library, availableCategories, updateTrack, activeSceneId]);

  // --- Render ---

  // Scene needs a contract before track generation makes sense — the LLM
  // depends on chord/contract context to voice notes intelligently. Mirror
  // synth-generator + drum-generator's placeholder.
  if (!sceneContext?.hasContract) {
    return (
      <div data-testid="no-contract-placeholder-instrument" className="flex items-center justify-center py-8">
        <button
          onClick={() => onOpenContract?.()}
          className="text-sas-muted text-xs hover:text-sas-accent transition-colors underline underline-offset-2"
        >
          Generate a Contract
        </button>
      </div>
    );
  }

  if (packStatus !== 'current') {
    return (
      <SamplePackCTACard
        host={host}
        pack={packInfo}
        status={packStatus}
        onDownloadComplete={refreshPackStatus}
      />
    );
  }

  return (
    <div data-testid="instrument-section" className="p-2 space-y-2">
      {libraryError && (
        <div className="text-xs text-red-400 px-2 py-1">{libraryError}</div>
      )}

      {tracks.map(track => (
        <TrackRow
          key={track.handle.id}
          track={{ id: track.handle.id, name: track.handle.name, role: track.category }}
          prompt={track.prompt}
          runtimeState={{
            muted: track.muted,
            solo: track.solo,
            volume: track.volume,
            pan: track.pan,
          }}
          fxDetailState={track.fxDetailState}
          fxDrawerOpen={track.fxDrawerOpen}
          isGenerating={track.isGenerating}
          isAuthenticated={isAuthenticated}
          error={track.error}
          hasMidi={track.hasMidi}
          generationProgress={track.generationProgress}
          estimatedGenerationMs={ESTIMATED_GENERATION_MS}
          onPromptChange={(p: string) => handlePromptChange(track.handle.id, p)}
          onGenerate={() => handleGenerate(track.handle.id)}
          onCopy={() => handleCopy(track.handle.id)}
          onShuffle={() => handleShuffle(track.handle.id)}
          onFxToggle={(cat: FxCategory, en: boolean) => handleFxToggle(track.handle.id, cat, en)}
          onFxPresetChange={(cat: FxCategory, idx: number) => handleFxPresetChange(track.handle.id, cat, idx)}
          onFxDryWetChange={(cat: FxCategory, v: number) => handleFxDryWetChange(track.handle.id, cat, v)}
          onToggleFxDrawer={() => toggleFxDrawer(track.handle.id)}
          onDelete={() => handleDeleteTrack(track.handle.id)}
          onMuteToggle={() => handleMuteToggle(track.handle.id)}
          onSoloToggle={() => handleSoloToggle(track.handle.id)}
          onVolumeChange={(v: number) => handleVolumeChange(track.handle.id, v)}
          onPanChange={(p: number) => handlePanChange(track.handle.id, p)}
          accentColor={INSTRUMENT_ACCENT_COLOR}
          instrumentName={track.loadedInstrumentName}
        />
      ))}
    </div>
  );
}

// parseLLMInstrumentResponse + LLMInstrumentResponse extracted to
// ./src/parse-llm-response.ts (shared with the agent-facing generate_instrument
// skill in src/main/services/plugin-skill-handlers.ts).

/**
 * Convert the SDK's PluginTrackFxDetailState (fetched via host.getTrackFxState)
 * into the slimmer TrackFxDetailState shape the TrackRow component expects.
 * Lifted verbatim from DrumGeneratorPanel.tsx:1015-1028 — generic helper, no
 * drum-specific bits.
 */
function pluginFxToToggleFx(sdkState: PluginTrackFxDetailState): TrackFxDetailState {
  const result = { ...EMPTY_FX_DETAIL_STATE };
  for (const category of ['eq', 'compressor', 'chorus', 'phaser', 'delay', 'reverb'] as const) {
    const sdkCat = sdkState[category] as PluginFxCategoryDetailState | undefined;
    if (sdkCat) {
      result[category] = {
        enabled: sdkCat.enabled,
        presetIndex: sdkCat.presetIndex,
        dryWet: sdkCat.dryWet,
      };
    }
  }
  return result;
}

// Re-export for the panel container; keeps the InstrumentGeneratorPlugin's
// index.ts dependency surface unchanged across the rewrite.
export default InstrumentGeneratorPanel;
