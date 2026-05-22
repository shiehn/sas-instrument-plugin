/**
 * Minimal walking-skeleton UI for the instrument-generator plugin.
 *
 * Three controls — Category dropdown, Instrument dropdown, Load on Track
 * button — that together prove the contract:
 *
 *   manifest.json on disk
 *      ↓ resolver
 *   InstrumentZone[]
 *      ↓ host.setTrackInstrumentSampler
 *   PluginManager::setSamplerMultiZone
 *      ↓
 *   Tracktion sampler → audio when MIDI hits the track
 *
 * No prompt input, no LLM, no zone editor — those land in v1.x once
 * the audio path has been validated end-to-end. MIDI is expected to
 * come from an external controller, a hand-written clip, or another
 * plugin running on the same scene.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import type { PluginUIProps, PluginTrackHandle } from '@signalsandsorcery/plugin-sdk';
import { loadLibrary, DEFAULT_SAMPLE_ROOT, type InstrumentLibrary, type ResolvedInstrument } from './src/instrument-resolver';

export function InstrumentGeneratorPanel(props: PluginUIProps) {
  const { host } = props;
  const [library, setLibrary] = useState<InstrumentLibrary | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [selectedCategory, setSelectedCategory] = useState<string>('');
  const [selectedInstrumentId, setSelectedInstrumentId] = useState<string>('');
  const [activeTrack, setActiveTrack] = useState<PluginTrackHandle | null>(null);
  const [status, setStatus] = useState<string>('Scanning library...');
  const [isBusy, setIsBusy] = useState(false);

  // Initial scan + reclaim any existing instrument track owned by this plugin.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const lib = await loadLibrary(host, DEFAULT_SAMPLE_ROOT);
        if (cancelled) return;
        setLibrary(lib);
        if (lib.categories.length > 0) {
          setSelectedCategory(lib.categories[0]);
          const first = lib.byCategory.get(lib.categories[0])?.[0];
          if (first) setSelectedInstrumentId(first.instrumentId);
          setStatus(`Library: ${lib.all.length} instruments across ${lib.categories.length} categories`);
        } else {
          setStatus(
            `No instruments found under ${DEFAULT_SAMPLE_ROOT}/instruments. ` +
            `Run the pitched-sample pipeline or symlink the outputs directory.`
          );
        }

        // Reclaim an existing track if the plugin owns one already.
        const handles = await host.getPluginTracks();
        if (!cancelled && handles.length > 0) {
          setActiveTrack(handles[0]);
        }
      } catch (err) {
        if (!cancelled) {
          const msg = err instanceof Error ? err.message : String(err);
          setLoadError(msg);
          setStatus(`Failed to scan library: ${msg}`);
        }
      }
    })();
    return () => { cancelled = true; };
  }, [host]);

  const categoryInstruments = useMemo<ResolvedInstrument[]>(() => {
    if (!library || !selectedCategory) return [];
    return library.byCategory.get(selectedCategory) ?? [];
  }, [library, selectedCategory]);

  const selectedInstrument = useMemo<ResolvedInstrument | null>(() => {
    if (!selectedInstrumentId) return null;
    return categoryInstruments.find(i => i.instrumentId === selectedInstrumentId) ?? null;
  }, [categoryInstruments, selectedInstrumentId]);

  const onCategoryChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    const cat = e.target.value;
    setSelectedCategory(cat);
    const first = library?.byCategory.get(cat)?.[0];
    setSelectedInstrumentId(first?.instrumentId ?? '');
  }, [library]);

  const onInstrumentChange = useCallback((e: React.ChangeEvent<HTMLSelectElement>) => {
    setSelectedInstrumentId(e.target.value);
  }, []);

  const onLoad = useCallback(async () => {
    if (!selectedInstrument) return;
    setIsBusy(true);
    setStatus(`Loading ${selectedInstrument.displayName}...`);
    try {
      let track = activeTrack;
      if (!track) {
        track = await host.createTrack({ name: `instrument-${Date.now()}` });
        setActiveTrack(track);
      }
      await host.setTrackInstrumentSampler(track.id, {
        name: selectedInstrument.displayName,
        zones: selectedInstrument.zones,
      });
      setStatus(`Loaded "${selectedInstrument.displayName}" (${selectedInstrument.zones.length} zones) on track ${track.id}`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(`Load failed: ${msg}`);
    } finally {
      setIsBusy(false);
    }
  }, [selectedInstrument, activeTrack, host]);

  const onRescan = useCallback(async () => {
    setLibrary(null);
    setStatus('Re-scanning library...');
    try {
      const lib = await loadLibrary(host, DEFAULT_SAMPLE_ROOT);
      setLibrary(lib);
      setStatus(`Library: ${lib.all.length} instruments across ${lib.categories.length} categories`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      setStatus(`Rescan failed: ${msg}`);
    }
  }, [host]);

  return (
    <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ fontSize: 12, opacity: 0.7 }}>
        Walking-skeleton: load a pitched-sample instrument on a track and play MIDI through it.
      </div>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 11, opacity: 0.7 }}>Category</span>
        <select value={selectedCategory} onChange={onCategoryChange} disabled={!library || isBusy}>
          {library?.categories.map(cat => (
            <option key={cat} value={cat}>
              {cat} ({library.byCategory.get(cat)?.length ?? 0})
            </option>
          ))}
        </select>
      </label>

      <label style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        <span style={{ fontSize: 11, opacity: 0.7 }}>Instrument</span>
        <select value={selectedInstrumentId} onChange={onInstrumentChange} disabled={categoryInstruments.length === 0 || isBusy}>
          {categoryInstruments.map(inst => (
            <option key={inst.instrumentId} value={inst.instrumentId}>{inst.displayName}</option>
          ))}
        </select>
      </label>

      <div style={{ display: 'flex', gap: 6 }}>
        <button onClick={onLoad} disabled={!selectedInstrument || isBusy}>
          {activeTrack ? 'Swap onto track' : 'Load on new track'}
        </button>
        <button onClick={onRescan} disabled={isBusy}>Re-scan</button>
      </div>

      {selectedInstrument && (
        <details style={{ fontSize: 11, opacity: 0.7 }}>
          <summary>Manifest details</summary>
          <div>id: {selectedInstrument.instrumentId}</div>
          <div>prompt: {selectedInstrument.prompt}</div>
          <div>zones: {selectedInstrument.zones.length}</div>
          <div>open-ended: {selectedInstrument.zones[0]?.openEnded ? 'yes' : 'no'}</div>
          <div style={{ wordBreak: 'break-all', opacity: 0.6 }}>dir: {selectedInstrument.manifestDir}</div>
        </details>
      )}

      <div style={{
        fontSize: 11,
        padding: 6,
        background: 'rgba(0,0,0,0.05)',
        borderLeft: loadError ? '3px solid #d24' : '3px solid #888',
      }}>
        {status}
      </div>
    </div>
  );
}

export default InstrumentGeneratorPanel;
