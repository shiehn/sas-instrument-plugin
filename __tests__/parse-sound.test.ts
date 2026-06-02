/**
 * Phase-2 parser coverage: the optional `sound` sonic descriptor.
 *
 * Asserts the field is non-breaking — a response that omits `sound` still
 * parses exactly as before.
 */

import { describe, it, expect } from '@jest/globals';
import { parseLLMInstrumentResponse } from '../src/parse-llm-response';

const NOTE = { pitch: 60, startBeat: 0, durationBeats: 1.0, velocity: 96 };

describe('parseLLMInstrumentResponse — sound field', () => {
  it('extracts a non-empty sound descriptor', () => {
    const parsed = parseLLMInstrumentResponse(
      JSON.stringify({ notes: [NOTE], category: 'pianos', sound: 'warm vintage valve mellow' }),
    );
    expect(parsed?.sound).toBe('warm vintage valve mellow');
    expect(parsed?.category).toBe('pianos');
  });

  it('is undefined when omitted (non-breaking with older output)', () => {
    const parsed = parseLLMInstrumentResponse(JSON.stringify({ notes: [NOTE], category: 'pianos' }));
    expect(parsed?.sound).toBeUndefined();
    expect(parsed?.notes).toHaveLength(1);
  });

  it('is undefined for an empty or non-string sound', () => {
    expect(parseLLMInstrumentResponse(JSON.stringify({ notes: [NOTE], sound: '' }))?.sound).toBeUndefined();
    expect(parseLLMInstrumentResponse(JSON.stringify({ notes: [NOTE], sound: 7 }))?.sound).toBeUndefined();
  });
});
