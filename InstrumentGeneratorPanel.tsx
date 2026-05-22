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
  PluginMidiNote,
  MidiClipData,
} from '@signalsandsorcery/plugin-sdk';
import { TrackRow, EMPTY_FX_DETAIL_STATE } from '@signalsandsorcery/plugin-sdk';
import { buildInstrumentSystemPrompt } from './src/instrument-system-prompt';
import { loadLibrary, pickInstrument, DEFAULT_SAMPLE_ROOT, type InstrumentLibrary, type ResolvedInstrument } from './src/instrument-resolver';

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
  isGenerating: boolean;
  error: string | null;
  hasMidi: boolean;
  generationProgress: number;
  // Volume/pan/mute/solo — local state only, kept in sync with host.
  muted: boolean;
  solo: boolean;
  volume: number;
  pan: number;
}

interface LLMInstrumentResponse {
  notes: PluginMidiNote[];
  category?: string;
}

export function InstrumentGeneratorPanel({
  host,
  activeSceneId,
  isAuthenticated,
  isConnected,
  onExpandSelf,
}: PluginUIProps): React.ReactElement {
  const [tracks, setTracks] = useState<InstrumentTrackState[]>([]);
  const [library, setLibrary] = useState<InstrumentLibrary | null>(null);
  const [libraryError, setLibraryError] = useState<string | null>(null);
  const [isAddingTrack, setIsAddingTrack] = useState(false);
  const isAddingTrackRef = useRef(false);

  // --- Initial library scan + reclaim any existing instrument tracks on this scene ---
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const lib = await loadLibrary(host, DEFAULT_SAMPLE_ROOT);
        if (cancelled) return;
        setLibrary(lib);

        // Reclaim tracks the plugin already owns (e.g. after scene switch).
        const handles = await host.getPluginTracks();
        if (cancelled) return;
        setTracks(handles.map(handle => ({
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
        })));
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          setLibraryError(msg);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [host, activeSceneId]);

  const availableCategories = useMemo<string[]>(
    () => library?.categories ?? [],
    [library],
  );

  // --- Add Track ---
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
      host.showToast('warning', 'Empty library', `No instruments found under ${DEFAULT_SAMPLE_ROOT}/instruments. Run the sample pipeline first.`);
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

  // --- Per-track state updates ---
  const updateTrack = useCallback((trackId: string, patch: Partial<InstrumentTrackState>) => {
    setTracks(prev => prev.map(t => t.handle.id === trackId ? { ...t, ...patch } : t));
  }, []);

  const handlePromptChange = useCallback((trackId: string, prompt: string): void => {
    updateTrack(trackId, { prompt });
  }, [updateTrack]);

  const handleDeleteTrack = useCallback(async (trackId: string): Promise<void> => {
    try {
      await host.deleteTrack(trackId);
      setTracks(prev => prev.filter(t => t.handle.id !== trackId));
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Unknown error';
      host.showToast('error', 'Failed to delete track', msg);
    }
  }, [host]);

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
        } catch (err) {
          console.warn('[InstrumentGeneratorPanel] setTrackInstrumentSampler failed:', err);
        }
      }

      updateTrack(trackId, {
        isGenerating: false,
        error: null,
        category: chosenCategory,
        loadedInstrumentId,
        loadedInstrumentName,
        hasMidi: true,
        generationProgress: 0,
      });
      host.showToast('success', `Generated · ${chosenCategory} · ${loadedInstrumentName ?? '—'}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Generation failed';
      updateTrack(trackId, { isGenerating: false, error: msg, generationProgress: 0 });
      host.showToast('error', 'Generation failed', msg);
    }
  }, [host, tracks, isAuthenticated, library, availableCategories, updateTrack]);

  // --- Render ---
  return (
    <div data-testid="instrument-section" className="p-2 space-y-2">
      {libraryError && (
        <div className="text-xs text-red-400 px-2 py-1">{libraryError}</div>
      )}

      {library && availableCategories.length === 0 && (
        <div className="text-xs opacity-60 px-2 py-1">
          No instruments found under {DEFAULT_SAMPLE_ROOT}/instruments. Generate samples first.
        </div>
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
          fxDetailState={EMPTY_FX_DETAIL_STATE}
          fxDrawerOpen={false}
          isGenerating={track.isGenerating}
          isAuthenticated={isAuthenticated}
          error={track.error}
          hasMidi={track.hasMidi}
          generationProgress={track.generationProgress}
          estimatedGenerationMs={ESTIMATED_GENERATION_MS}
          onPromptChange={(p: string) => handlePromptChange(track.handle.id, p)}
          onGenerate={() => handleGenerate(track.handle.id)}
          onDelete={() => handleDeleteTrack(track.handle.id)}
          onMuteToggle={() => handleMuteToggle(track.handle.id)}
          onSoloToggle={() => handleSoloToggle(track.handle.id)}
          onVolumeChange={(v: number) => handleVolumeChange(track.handle.id, v)}
          onPanChange={(p: number) => handlePanChange(track.handle.id, p)}
          accentColor={INSTRUMENT_ACCENT_COLOR}
          instrumentName={track.loadedInstrumentName}
        />
      ))}

      <button
        data-testid="add-instrument-track"
        onClick={handleAddTrack}
        disabled={isAddingTrack || tracks.length >= MAX_TRACKS || availableCategories.length === 0}
        className="w-full px-2 py-1.5 text-[10px] uppercase tracking-wide rounded-sm border text-sas-muted hover:text-sas-accent border-sas-border hover:border-sas-accent transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
        title={
          availableCategories.length === 0
            ? 'Empty library — generate samples first'
            : tracks.length >= MAX_TRACKS
              ? `Track limit (${MAX_TRACKS}) reached`
              : 'Create a new instrument track'
        }
      >
        + Add Instrument Track
      </button>

      {availableCategories.length > 0 && (
        <div className="text-[10px] opacity-50 px-1">
          {availableCategories.length} {availableCategories.length === 1 ? 'category' : 'categories'} discovered: {availableCategories.join(', ')}
        </div>
      )}
    </div>
  );
}

/**
 * Parse the LLM's JSON response, tolerating ```json fences and validating
 * note fields. Mirrors the drum plugin's parser but with `category`
 * (singular, dynamic) instead of role+subRole.
 */
function parseLLMInstrumentResponse(content: string): LLMInstrumentResponse | null {
  try {
    let jsonStr = content.trim();
    const fenceMatch = jsonStr.match(/```(?:json)?\s*\n?([\s\S]*?)```/);
    if (fenceMatch) {
      jsonStr = fenceMatch[1].trim();
    }

    const parsed: unknown = JSON.parse(jsonStr);
    if (typeof parsed !== 'object' || parsed === null || !('notes' in parsed)) {
      return null;
    }

    const obj = parsed as Record<string, unknown>;
    if (!Array.isArray(obj.notes)) {
      return null;
    }

    const validNotes: PluginMidiNote[] = [];
    for (const raw of obj.notes) {
      if (typeof raw !== 'object' || raw === null) continue;
      const note = raw as Record<string, unknown>;

      const pitch = typeof note.pitch === 'number' ? note.pitch : NaN;
      const startBeat = typeof note.startBeat === 'number' ? note.startBeat : NaN;
      const durationBeats = typeof note.durationBeats === 'number' ? note.durationBeats : NaN;
      const velocity = typeof note.velocity === 'number' ? note.velocity : NaN;

      if (
        !isNaN(pitch) && pitch >= 0 && pitch <= 127
        && !isNaN(startBeat) && startBeat >= 0
        && !isNaN(durationBeats) && durationBeats > 0
        && !isNaN(velocity) && velocity >= 1 && velocity <= 127
      ) {
        validNotes.push({
          pitch: Math.round(pitch),
          startBeat,
          durationBeats,
          velocity: Math.round(velocity),
        });
      }
    }

    const category = typeof obj.category === 'string' ? obj.category : undefined;
    return { notes: validNotes, category };
  } catch {
    return null;
  }
}

// Re-export for the panel container; keeps the InstrumentGeneratorPlugin's
// index.ts dependency surface unchanged across the rewrite.
export default InstrumentGeneratorPanel;
