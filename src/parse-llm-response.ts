/**
 * Parser for the pitched-instrument LLM response.
 *
 * Extracted from InstrumentGeneratorPanel.tsx so the SAME parser backs both
 * generation paths:
 *   - the panel's "Generate" button (renderer), and
 *   - the agent-facing `generate_instrument` plugin skill (main process,
 *     see src/main/services/plugin-skill-handlers.ts).
 *
 * Mirrors the drum plugin's parser but with `category` (singular, dynamic)
 * instead of role. Pure function, no I/O — safe to import into either process.
 */

import type { PluginMidiNote } from '@signalsandsorcery/plugin-sdk';

export interface LLMInstrumentResponse {
  notes: PluginMidiNote[];
  category?: string;
}

export function parseLLMInstrumentResponse(content: string): LLMInstrumentResponse | null {
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
