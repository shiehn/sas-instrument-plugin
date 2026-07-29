/**
 * Meter-awareness of the instrument system prompt (P8a multi-time-signature).
 *
 * BYTE-IDENTITY PIN: the snapshot below was recorded from the PRE-meter
 * implementation (`buildInstrumentSystemPrompt(categories)` with no meter
 * parameter). After the meter parameter landed, the 4/4 prompt — with the
 * parameter omitted OR passed explicitly as '4/4' — must still match that
 * snapshot byte-for-byte. Never update this snapshot as part of a meter
 * change; a diff here means 4/4 behavior drifted.
 */
import { describe, it, expect } from '@jest/globals';
import { buildInstrumentSystemPrompt } from '../src/instrument-system-prompt';

const SAMPLE_CATEGORIES = ['plucks', 'pads', 'keys', 'basses', 'leads'] as const;

describe('buildInstrumentSystemPrompt — 4/4 byte identity', () => {
  it('4/4 output is byte-identical to the pre-meter prompt (snapshot pin)', () => {
    expect(buildInstrumentSystemPrompt(SAMPLE_CATEGORIES)).toMatchSnapshot();
  });

  it('the empty-library fallback is byte-identical too (snapshot pin)', () => {
    expect(buildInstrumentSystemPrompt([])).toMatchSnapshot();
  });

  it("omitted, explicit '4/4', and unparseable meters all produce the identical legacy prompt", () => {
    const legacy = buildInstrumentSystemPrompt(SAMPLE_CATEGORIES);
    expect(buildInstrumentSystemPrompt(SAMPLE_CATEGORIES, '4/4')).toBe(legacy);
    expect(buildInstrumentSystemPrompt(SAMPLE_CATEGORIES, 'waltz')).toBe(legacy);
    expect(buildInstrumentSystemPrompt(SAMPLE_CATEGORIES, '')).toBe(legacy);
  });
});

describe('buildInstrumentSystemPrompt — non-4/4 meters', () => {
  it('3/4 extends the bar-count line with the meter arithmetic and appends waltz rules', () => {
    const prompt = buildInstrumentSystemPrompt(SAMPLE_CATEGORIES, '3/4');
    expect(prompt).toContain('each bar of 3/4 spans 3 quarter-note beats');
    expect(prompt).toContain('Time signature 3/4 — meter rules:');
    expect(prompt).toContain('NO beats-2-and-4 backbeat');
    // The legacy bar-count line is replaced, not duplicated.
    expect(prompt).not.toContain('- Match the bar count and tempo from the musical context.\n');
  });

  it('6/8 appends the compound-duple rules (second pulse, eighth-note slots)', () => {
    const prompt = buildInstrumentSystemPrompt(SAMPLE_CATEGORIES, '6/8');
    expect(prompt).toContain('Time signature 6/8 — meter rules:');
    expect(prompt).toContain('SECOND pulse');
    expect(prompt).toContain('one slot = one eighth note = 0.5 qn');
  });

  it('7/8 states the fractional bar span and grouping', () => {
    const prompt = buildInstrumentSystemPrompt(SAMPLE_CATEGORIES, '7/8');
    expect(prompt).toContain('each bar of 7/8 spans 3.5 quarter-note beats');
    expect(prompt).toContain('2+2+3');
  });

  it('non-4/4 prompts keep the meter-independent contract lines (categories, polyphony)', () => {
    const prompt = buildInstrumentSystemPrompt(SAMPLE_CATEGORIES, '9/8');
    expect(prompt).toContain(SAMPLE_CATEGORIES.join(', '));
    expect(prompt).toContain('Polyphony: multiple simultaneous notes');
  });

  it('the empty-library fallback ignores the meter (defensive path unchanged)', () => {
    expect(buildInstrumentSystemPrompt([], '6/8')).toBe(buildInstrumentSystemPrompt([]));
  });
});
