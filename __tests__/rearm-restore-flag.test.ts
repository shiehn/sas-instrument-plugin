/**
 * Sampler re-arm on scene load must be a RESTORE, not a sound edit.
 *
 * The panel replays each track's persisted current sound (the
 * `track:<dbId>:soundHistory` entry at `cursor`) through
 * `host.setTrackInstrumentSampler` on every scene load — the engine restores
 * sampler state from the saved project, but when the zone files were missing
 * at open time (sample library not yet installed) the sampler comes up EMPTY
 * and the track plays silence until the next sound edit (2026-07-27
 * missing-library incident). The host treats an instrument set as a sound
 * edit and auto-unfreezes frozen tracks so the edit is audible — correct for
 * user changes, wrong for the replay: without the `restore: true` marker,
 * switching scenes would silently unfreeze every frozen instrument track
 * (the 2026-07-27 drum-panel bug, same shape).
 *
 * Host-side behavior (restore skips the freeze gate + re-persistence) is
 * covered in sas-app's `instrument-sampler-restore-freeze-gate.test.ts`.
 * This guard pins the panel's side of the contract: the re-arm call — and
 * ONLY the re-arm call — passes `restore: true`. Every user-driven
 * instrument set (generate, shuffle, sound-history restore, sample import)
 * must keep edit semantics.
 */

import { describe, it, expect } from '@jest/globals';
import * as fs from 'fs';
import * as path from 'path';
import type { InstrumentSampler } from '@signalsandsorcery/plugin-sdk';

const PANEL_SOURCE = fs.readFileSync(
  path.join(__dirname, '..', 'InstrumentGeneratorPanel.tsx'),
  'utf-8'
);

/** Every `setTrackInstrumentSampler(...)` call in the panel, with balanced parens. */
function extractSamplerCalls(source: string): Array<{ args: string; offset: number }> {
  const calls: Array<{ args: string; offset: number }> = [];
  const marker = 'setTrackInstrumentSampler(';
  let from = 0;
  for (;;) {
    const start = source.indexOf(marker, from);
    if (start === -1) break;
    let depth = 1;
    let i = start + marker.length;
    while (i < source.length && depth > 0) {
      if (source[i] === '(') depth += 1;
      else if (source[i] === ')') depth -= 1;
      i += 1;
    }
    calls.push({ args: source.slice(start + marker.length, i - 1), offset: start });
    from = i;
  }
  return calls;
}

describe('InstrumentGeneratorPanel setTrackInstrumentSampler restore discipline', () => {
  const calls = extractSamplerCalls(PANEL_SOURCE);

  it('the SDK InstrumentSampler contract accepts the restore marker (stale-SDK guard)', () => {
    // Type-level: fails to compile against an SDK build without the field.
    const replay: InstrumentSampler = {
      name: 'replayed choir',
      zones: [{ samplePath: '/lib/060.wav', rootKey: 60, minKey: 0, maxKey: 127, openEnded: false }],
      restore: true,
    };
    expect(replay.restore).toBe(true);
  });

  it('finds the panel call sites (extraction sanity)', () => {
    // applyInstrumentSound (generate/history/import), shuffle paths, re-arm.
    expect(calls.length).toBeGreaterThanOrEqual(3);
  });

  it('exactly ONE call passes restore: true — the re-arm-on-load replay', () => {
    const restoreCalls = calls.filter((c) => /restore:\s*true/.test(c.args));
    expect(restoreCalls).toHaveLength(1);

    // It must be the documented re-arm block, not a user-facing path.
    const preceding = PANEL_SOURCE.slice(
      Math.max(0, restoreCalls[0].offset - 900),
      restoreCalls[0].offset
    );
    expect(preceding).toMatch(/Re-arm the multi-zone sampler/);
  });

  it('every user-driven instrument set keeps sound-edit semantics (no restore flag)', () => {
    const editCalls = calls.filter((c) => !/restore:\s*true/.test(c.args));
    expect(editCalls.length).toBe(calls.length - 1);
    for (const call of editCalls) {
      expect(call.args).not.toMatch(/restore/);
    }
  });
});
