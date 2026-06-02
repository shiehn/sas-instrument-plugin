/**
 * loadLibrary caching + bounded-concurrency tests.
 *
 * v3 (5,475 manifests over ~77k files) made the uncached, sequential scan a
 * multi-second stall on EVERY generate/shuffle. These tests assert the library
 * is cached per-root (validated by the pack `_pack-version.json` version),
 * rebuilt on a version change or explicit invalidation, and that the parallel
 * build still loads every instrument.
 */

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import { loadLibrary, invalidateInstrumentLibraryCache } from '../src/instrument-resolver';
import type { PluginHost } from '@signalsandsorcery/plugin-sdk';

const WAVS = ['/lib/keys/k1/zones/060.wav', '/lib/keys/k2/zones/060.wav'];

function manifest(id: string): string {
  return JSON.stringify({
    schema_version: 1,
    instrument_id: id,
    category_id: 'keys',
    category_display: 'Keys',
    prompt: `${id} warm electric piano`,
    open_ended: false,
    zones: [{ sample: 'zones/060.wav', root_midi: 60, min_midi: 0, max_midi: 127 }],
  });
}

/** Host whose `_pack-version.json` version is read from the mutable `marker`. */
function makeHost(marker: { v: string | null }): {
  host: PluginHost;
  readTextFile: jest.Mock;
} {
  const listAudioFiles = jest.fn(async () => WAVS);
  const readTextFile = jest.fn(async (p: string) => {
    if (p.endsWith('_pack-version.json')) {
      return marker.v === null ? JSON.stringify({}) : JSON.stringify({ version: marker.v });
    }
    if (p === '/lib/keys/k1/manifest.json') return manifest('keys-k1');
    if (p === '/lib/keys/k2/manifest.json') return manifest('keys-k2');
    return null;
  });
  return {
    host: { listAudioFiles, readTextFile } as unknown as PluginHost,
    readTextFile: readTextFile as unknown as jest.Mock,
  };
}

const manifestReads = (readTextFile: jest.Mock): number =>
  readTextFile.mock.calls.filter((c) => String(c[0]).endsWith('manifest.json')).length;

describe('loadLibrary cache + concurrency', () => {
  // The cache is module-level — clear it between tests for isolation.
  beforeEach(() => invalidateInstrumentLibraryCache());

  it('loads every instrument (parallel build preserves completeness)', async () => {
    const { host } = makeHost({ v: '3' });
    const lib = await loadLibrary(host, '/lib');
    expect(lib.all).toHaveLength(2);
    expect(lib.categories).toEqual(['keys']);
    expect(lib.byCategory.get('keys')?.map((i) => i.instrumentId).sort()).toEqual(['keys-k1', 'keys-k2']);
  });

  it('caches by version — a second call does not re-read manifests', async () => {
    const { host, readTextFile } = makeHost({ v: '3' });
    await loadLibrary(host, '/lib');
    expect(manifestReads(readTextFile)).toBe(2);
    const lib2 = await loadLibrary(host, '/lib'); // cache hit
    expect(manifestReads(readTextFile)).toBe(2); // unchanged
    expect(lib2.all).toHaveLength(2);
  });

  it('dedupes concurrent first-loads into a single scan', async () => {
    const { host, readTextFile } = makeHost({ v: '3' });
    const [a, b] = await Promise.all([loadLibrary(host, '/lib'), loadLibrary(host, '/lib')]);
    expect(a).toBe(b); // same cached promise resolution
    expect(manifestReads(readTextFile)).toBe(2); // not 4
  });

  it('rebuilds when the pack version changes', async () => {
    const marker = { v: '3' };
    const { host, readTextFile } = makeHost(marker);
    await loadLibrary(host, '/lib');
    expect(manifestReads(readTextFile)).toBe(2);
    marker.v = '4'; // pack re-installed at a new version
    await loadLibrary(host, '/lib');
    expect(manifestReads(readTextFile)).toBe(4);
  });

  it('invalidateInstrumentLibraryCache() forces a rebuild', async () => {
    const { host, readTextFile } = makeHost({ v: '3' });
    await loadLibrary(host, '/lib');
    invalidateInstrumentLibraryCache();
    await loadLibrary(host, '/lib');
    expect(manifestReads(readTextFile)).toBe(4);
  });

  it('does not cache when there is no version marker (always rebuilds)', async () => {
    const { host, readTextFile } = makeHost({ v: null }); // marker has no version field → ''
    await loadLibrary(host, '/lib');
    await loadLibrary(host, '/lib');
    expect(manifestReads(readTextFile)).toBe(4); // re-read both times
  });
});
