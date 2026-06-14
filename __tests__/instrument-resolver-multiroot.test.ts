/**
 * loadLibraries multi-root tests (local-samples spike, Phase 2).
 *
 * The instrument panel scans the distributed pack root AND every user-imported
 * pack root, merging them into one library. These tests pin that merge: each
 * root contributes its instruments, results are origin-tagged, and a failing
 * root is skipped without sinking the others.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { loadLibraries, invalidateInstrumentLibraryCache } from '../src/instrument-resolver';
import type { PluginHost } from '@signalsandsorcery/plugin-sdk';

const DIST = '/packs/instruments';
const USER = '/user/instruments/my-keys';

const FILES: Record<string, string[]> = {
  [DIST]: ['/packs/instruments/keys/k1/zones/060.wav'],
  [USER]: ['/user/instruments/my-keys/basses/b1/b1.wav', '/user/instruments/my-keys/keys/u1/u1.wav'],
};

function manifest(categoryId: string, id: string, sample: string, root = 60): string {
  return JSON.stringify({
    schema_version: 1,
    instrument_id: id,
    category_id: categoryId,
    category_display: categoryId,
    prompt: `${id} sound`,
    open_ended: false,
    zones: [{ sample, root_midi: root, min_midi: 0, max_midi: 127 }],
  });
}

const MANIFESTS: Record<string, string> = {
  '/packs/instruments/keys/k1/manifest.json': manifest('keys', 'dist-k1', 'zones/060.wav'),
  '/user/instruments/my-keys/basses/b1/manifest.json': manifest('basses', 'user-b1', 'b1.wav', 36),
  '/user/instruments/my-keys/keys/u1/manifest.json': manifest('keys', 'user-u1', 'u1.wav', 48),
};

function makeHost(opts: { failRoot?: string } = {}): PluginHost {
  const listAudioFiles = jest.fn(async (root: string) => {
    if (opts.failRoot && root === opts.failRoot) throw new Error('boom');
    return FILES[root] ?? [];
  });
  const readTextFile = jest.fn(async (p: string) => {
    if (p.endsWith('_pack-version.json')) return JSON.stringify({ version: '1' });
    return MANIFESTS[p] ?? null;
  });
  return { listAudioFiles, readTextFile } as unknown as PluginHost;
}

describe('loadLibraries multi-root', () => {
  beforeEach(() => invalidateInstrumentLibraryCache());

  it('merges instruments from every root and tags origin', async () => {
    const host = makeHost();
    const lib = await loadLibraries(host, [
      { path: DIST, origin: 'distributed' },
      { path: USER, origin: 'user' },
    ]);

    expect(lib.all).toHaveLength(3);
    expect(lib.categories).toEqual(['basses', 'keys']);
    // keys pool merges the distributed + user instruments.
    expect(lib.byCategory.get('keys')?.map((i) => i.instrumentId).sort()).toEqual(['dist-k1', 'user-u1']);
    expect(lib.byCategory.get('basses')?.map((i) => i.instrumentId)).toEqual(['user-b1']);

    const byId = Object.fromEntries(lib.all.map((i) => [i.instrumentId, i.origin]));
    expect(byId['dist-k1']).toBe('distributed');
    expect(byId['user-b1']).toBe('user');
    expect(byId['user-u1']).toBe('user');
  });

  it('preserves each instrument\'s own root note across roots', async () => {
    const host = makeHost();
    const lib = await loadLibraries(host, [
      { path: DIST, origin: 'distributed' },
      { path: USER, origin: 'user' },
    ]);
    const bass = lib.all.find((i) => i.instrumentId === 'user-b1');
    expect(bass?.zones[0].rootKey).toBe(36);
  });

  it('skips a failing root but still loads the others', async () => {
    const host = makeHost({ failRoot: DIST });
    const lib = await loadLibraries(host, [
      { path: DIST, origin: 'distributed' },
      { path: USER, origin: 'user' },
    ]);
    expect(lib.all.map((i) => i.instrumentId).sort()).toEqual(['user-b1', 'user-u1']);
  });

  it('returns an empty library when given no roots', async () => {
    const lib = await loadLibraries(makeHost(), []);
    expect(lib.all).toEqual([]);
    expect(lib.categories).toEqual([]);
  });
});
