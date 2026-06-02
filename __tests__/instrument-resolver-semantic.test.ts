/**
 * Query-aware pickInstrument tests.
 *
 * pickInstrument is a pure function over an already-loaded library (each
 * ResolvedInstrument carries its StableAudio `prompt`), so these tests build
 * the library directly — no host mock needed. They verify semantic bias plus
 * the two fallbacks that must preserve today's behavior: no query, and the
 * empty-prompt legacy packs (v1/v2) where every prompt is "".
 */

import { describe, it, expect } from '@jest/globals';
import {
  pickInstrument,
  type InstrumentLibrary,
  type ResolvedInstrument,
} from '../src/instrument-resolver';

function inst(id: string, prompt: string): ResolvedInstrument {
  return {
    categoryId: 'basses',
    categoryDisplay: 'Basses',
    instrumentId: id,
    displayName: id,
    prompt,
    zones: [],
    manifestDir: `/lib/instruments/basses/${id}`,
  };
}

function libOf(instruments: ResolvedInstrument[]): InstrumentLibrary {
  const byCategory = new Map<string, ResolvedInstrument[]>();
  for (const i of instruments) {
    const list = byCategory.get(i.categoryId) ?? [];
    list.push(i);
    byCategory.set(i.categoryId, list);
  }
  return { categories: Array.from(byCategory.keys()), byCategory, all: instruments };
}

const LIB = libOf([
  inst('b1', 'deep warm sub bass one shot, round low fundamental, smooth sine, saturated'),
  inst('b2', 'gritty distorted reese bass one shot, aggressive midrange, detuned saw'),
  inst('b3', 'vintage upright acoustic bass one shot, woody warm tone, fingered'),
]);

describe('pickInstrument query-aware', () => {
  it('biases toward the matching instrument for "vintage acoustic upright woody"', () => {
    const picked = pickInstrument(LIB, 'basses', {
      query: 'vintage acoustic upright woody',
      rng: () => 0,
    });
    expect(picked?.instrumentId).toBe('b3');
  });

  it('matches "gritty distorted reese" to the reese bass', () => {
    const picked = pickInstrument(LIB, 'basses', { query: 'gritty distorted reese', rng: () => 0 });
    expect(picked?.instrumentId).toBe('b2');
  });

  it('no-query pick stays uniform random (rng=0 → first of pool)', () => {
    const picked = pickInstrument(LIB, 'basses', { rng: () => 0 });
    expect(picked?.instrumentId).toBe('b1');
  });

  it('legacy empty-prompt pack: a query falls back to random (no crash, no bias)', () => {
    const emptyLib = libOf([inst('e1', ''), inst('e2', ''), inst('e3', '')]);
    const picked = pickInstrument(emptyLib, 'basses', { query: 'vintage acoustic', rng: () => 0 });
    expect(picked?.instrumentId).toBe('e1'); // all scores 0 → uniform random
  });

  it('falls back to random when the query has no token overlap', () => {
    const picked = pickInstrument(LIB, 'basses', { query: 'trumpet bagpipes', rng: () => 0 });
    expect(picked?.instrumentId).toBe('b1');
  });

  it('still accepts a bare Set as excludeIds (historical signature)', () => {
    const picked = pickInstrument(LIB, 'basses', new Set(['b1']));
    expect(picked?.instrumentId).not.toBe('b1');
  });

  it('honors excludeIds together with a query (excludes the best match)', () => {
    const picked = pickInstrument(LIB, 'basses', {
      query: 'vintage acoustic upright woody',
      excludeIds: new Set(['b3']),
      rng: () => 0,
    });
    expect(picked?.instrumentId).not.toBe('b3');
  });

  it('returns null for an unknown category', () => {
    expect(pickInstrument(LIB, 'flutes', { query: 'anything' })).toBeNull();
  });

  it('returns null when every candidate is excluded', () => {
    expect(pickInstrument(LIB, 'basses', new Set(['b1', 'b2', 'b3']))).toBeNull();
  });
});
