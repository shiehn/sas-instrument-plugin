/**
 * A new instrument track joins the scene's panel bus at once (S-027 S8, gap G1).
 *
 * The host routes a panel's tracks into its scene bus only inside a bus read
 * (`getPanelBusState`). Before this fix nothing re-read the bus after a
 * create, so a fresh track played OUTSIDE the bus until a scene switch or
 * reopen. SDK 3.19.0 added `usePanelBus().notifyTracksChanged()` (a stable,
 * coalesced re-read); this monolith panel (not built on the SDK shell) must
 * call it itself:
 *   - at the end of every successful, non-stale `loadTracks` pass, which is
 *     where port / crossfade / fade / copy / import / engine-ready / agent
 *     mutations all land;
 *   - in Add Track, the one create path that does NOT go through loadTracks.
 *
 * The SDK is stubbed wholesale: the panel under test is the only real React,
 * so the stubs also sidestep the SDK symlink's second React copy.
 */

import React from 'react';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { describe, it, expect, beforeEach, afterEach, jest } from '@jest/globals';
import type { PluginHost, PluginTrackHandle, PluginUIProps } from '@signalsandsorcery/plugin-sdk';

/* eslint-disable @typescript-eslint/no-explicit-any */
const fn = (): jest.Mock<any> => jest.fn<any>();

// Swapped per test: the object usePanelBus returns. Stable across renders,
// like the real hook's notifyTracksChanged (a useCallback with [] deps).
let mockPanelBus: Record<string, unknown> = {};

// Stable across renders: loadTracks lists soundHistory in its deps, so a new
// object per render would re-create loadTracks on every render.
const mockSoundHistory = {
  reset: jest.fn(),
  restore: jest.fn(),
  record: jest.fn(),
  clear: jest.fn(),
  restoreTo: jest.fn(),
  toggleFavorite: jest.fn(),
  list: () => ({ entries: [], cursor: -1 }),
};
const mockReorder = { dragPropsFor: () => ({}) };

jest.mock('@signalsandsorcery/plugin-sdk', () => ({
  TrackRow: () => null,
  PanelMasterStrip: () => null,
  ImportTrackModal: () => null,
  CrossfadeTrackRow: () => null,
  TransitionDesigner: () => null,
  FadeTrackRow: () => null,
  SamplePackCTACard: () => null,
  usePanelBus: () => mockPanelBus,
  useAnySolo: () => false,
  useSoundHistory: () => mockSoundHistory,
  useTrackReorder: () => mockReorder,
  useTrackLevels: () => null,
  formatConcurrentTracks: () => '',
  parseCrossfadePairs: () => [],
  parseFades: () => [],
  asCrossfadeMeta: () => null,
  asFadeMeta: () => null,
  soundIdentity: () => '',
  buildCrossfadeInpaintPrompt: () => '',
  buildCrossfadeVolumeCurves: () => ({ origin: [], target: [] }),
  buildFadeVolumeCurve: () => [],
  EQUAL_POWER_GAIN: 0.7071,
  panelClipEndSeconds: () => 8,
  panelQuarterNotesPerBar: () => 4,
  panelMeter: () => ({ numerator: 4, denominator: 4 }),
}));

// One installed category, so Add Track isn't refused as "Empty library".
jest.mock('../src/instrument-resolver', () => ({
  loadLibraries: jest.fn(async () => ({ categories: ['plucks'], byCategory: {}, instruments: [] })),
  invalidateInstrumentLibraryCache: jest.fn(),
  pickInstrument: jest.fn(),
}));

import { InstrumentGeneratorPanel } from '../InstrumentGeneratorPanel';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

function makeHandle(id: string): PluginTrackHandle {
  return { id, name: id, dbId: `db-${id}` } as PluginTrackHandle;
}

function makeHost(): PluginHost {
  const host: Record<string, any> = {
    // Sample pack: installed + current, so loadTracks does a full pass.
    isSamplePackCurrent: fn().mockResolvedValue(true),
    getSamplePackInstalledVersion: fn().mockResolvedValue('1'),
    getSamplePackRoot: fn().mockResolvedValue('/lib'),
    onSamplePackProgress: fn().mockReturnValue(() => {}),
    // Track load.
    adoptSceneTracks: fn().mockResolvedValue(undefined),
    getPluginTracks: fn().mockResolvedValue([makeHandle('t1')]),
    getAllSceneData: fn().mockResolvedValue({}),
    getTrackInfo: fn().mockResolvedValue({ muted: false, soloed: false, volume: 0.75, pan: 0, hasMidi: false }),
    // Listeners.
    onEngineReady: fn().mockReturnValue(() => {}),
    onAfterAgentMutation: fn().mockReturnValue(() => {}),
    // Add Track.
    createTrack: fn().mockResolvedValue(makeHandle('t2')),
    showToast: fn(),
  };
  return host as unknown as PluginHost;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

/** Let every pending promise chain (and the React commits they cause) settle. */
async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) {
    await act(async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
    });
  }
}

describe('InstrumentGeneratorPanel asks the panel bus to re-read when its tracks change', () => {
  let container: HTMLDivElement;
  let headerContainer: HTMLDivElement;
  let root: Root;
  let headerRoot: Root;
  let header: React.ReactNode = null;
  let host: PluginHost;
  let notify: jest.Mock<() => void>;

  async function mountPanel(): Promise<void> {
    const props = {
      host,
      activeSceneId: 'scene-1',
      isAuthenticated: true,
      isConnected: true,
      onHeaderContent: (node: React.ReactNode) => { header = node; },
      onOpenContract: jest.fn(),
      onExpandSelf: jest.fn(),
      sceneContext: { hasContract: true, sceneType: 'normal' },
      isExpanded: false,
    } as unknown as PluginUIProps;
    await act(async () => {
      root.render(<InstrumentGeneratorPanel {...props} />);
    });
    await settle();
  }

  /** Render the panel's accordion-header content and click "Add Track". */
  async function clickAddTrack(): Promise<void> {
    await act(async () => {
      headerRoot.render(<>{header}</>);
    });
    const button = headerContainer.querySelector('[data-testid="add-instrument-track-button"]');
    expect(button).not.toBeNull();
    await act(async () => {
      button!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    await settle();
  }

  beforeEach(() => {
    header = null;
    host = makeHost();
    notify = jest.fn<() => void>();
    mockPanelBus = { supported: false, bus: null, notifyTracksChanged: notify };
    container = document.createElement('div');
    headerContainer = document.createElement('div');
    document.body.append(container, headerContainer);
    root = createRoot(container);
    headerRoot = createRoot(headerContainer);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      headerRoot.unmount();
    });
    container.remove();
    headerContainer.remove();
  });

  it('a completed loadTracks pass notifies exactly once', async () => {
    await mountPanel();

    // One full pass (the pre-pack-status pass returns before loading).
    expect(host.adoptSceneTracks).toHaveBeenCalledTimes(1);
    expect(host.getPluginTracks).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it('Add Track notifies on its own, without a second track load', async () => {
    await mountPanel();
    notify.mockClear();

    await clickAddTrack();

    expect(host.createTrack).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(1);
    // Add Track appends the row locally: the notify is its own, not a reload's.
    expect(host.adoptSceneTracks).toHaveBeenCalledTimes(1);
    expect(host.showToast).not.toHaveBeenCalledWith('error', expect.anything(), expect.anything());
  });

  it('degrades to a no-op on an SDK without notifyTracksChanged', async () => {
    mockPanelBus = { supported: false, bus: null };
    await mountPanel();

    await clickAddTrack();

    expect(host.createTrack).toHaveBeenCalledTimes(1);
    expect(host.showToast).not.toHaveBeenCalledWith('error', expect.anything(), expect.anything());
  });
});
