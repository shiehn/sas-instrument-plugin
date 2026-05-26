/**
 * @signalsandsorcery/instrument-generator — Built-in Instrument Generator Plugin
 *
 * Walking-skeleton plugin for pitched, polyphonic sample-based instruments.
 * Sister to drum-generator but uses the multi-zone sampler path
 * (host.setTrackInstrumentSampler) so MIDI notes are pitch-shifted across
 * a chromatic range and zone overlaps are disallowed.
 *
 * The panel scans an instrument library produced by the pitched-sample
 * pipeline, runs LLM-driven MIDI generation, and loads a multi-zone sampler
 * per track. The same generate + shuffle flow is exposed to AI agents via
 * getSkills() below (orchestration in src/main/services/plugin-skill-handlers.ts).
 */

import type { ComponentType } from 'react';
import type {
  GeneratorPlugin,
  PluginHost,
  PluginUIProps,
  PluginSettingsSchema,
  PluginSkill,
  MusicalContext,
} from '@signalsandsorcery/plugin-sdk';
import { InstrumentGeneratorPanel } from './InstrumentGeneratorPanel';
import instrumentManifest from './plugin.json';

/** Plugin manifest (re-exported so the host registers it from the package root). */
export { instrumentManifest };

// Generation primitives — re-exported so the host's skill bridge
// (plugin-skill-handlers) can drive the `generate_instrument` skill without
// reaching into the plugin's internals. Same modules the panel uses.
export { buildInstrumentSystemPrompt } from './src/instrument-system-prompt';
export { loadLibrary, pickInstrument, type InstrumentLibrary, type ResolvedInstrument } from './src/instrument-resolver';
export { parseLLMInstrumentResponse } from './src/parse-llm-response';

export class InstrumentGeneratorPlugin implements GeneratorPlugin {
  readonly id = '@signalsandsorcery/instrument-generator';
  readonly displayName = 'Instruments';
  readonly version = '0.1.0';
  readonly description = 'Pitched, polyphonic sample-based instruments (walking skeleton)';
  readonly generatorType = 'midi' as const;
  readonly minHostVersion = '1.0.0';

  private host: PluginHost | null = null;

  async activate(host: PluginHost): Promise<void> {
    this.host = host;
    console.log('[InstrumentGeneratorPlugin] Activated');
  }

  async deactivate(): Promise<void> {
    this.host = null;
    console.log('[InstrumentGeneratorPlugin] Deactivated');
  }

  getUIComponent(): ComponentType<PluginUIProps> {
    return InstrumentGeneratorPanel;
  }

  getSettingsSchema(): PluginSettingsSchema | null {
    return null;
  }

  async onSceneChanged(_sceneId: string | null): Promise<void> {
    // Instrument tracks are loaded on demand by the user via the panel
  }

  onContextChanged(_context: MusicalContext): void {
    // No-op — generation is user/agent-triggered, not context-driven
  }

  /**
   * LLM-callable skills — the agent equivalents of the panel's Generate
   * button and 🎲 shuffle button. Orchestration lives in main
   * (src/main/services/plugin-skill-handlers.ts), which runs the SAME
   * host-method flow the panel does so the two paths can't drift.
   *
   * `generate_instrument` is surfaced on the default tool list (its
   * registration sets deferLoading:false). The descriptions steer the agent:
   * THIS for real / sampled / acoustic pitched instruments, `dsl_generate_midi`
   * for a synthesized Surge-XT instrument.
   */
  getSkills(): PluginSkill[] {
    return [
      {
        id: 'generate_instrument',
        description:
          'Generate a pitched, sample-based instrument part: creates a new track in the active scene, has the LLM compose a melodic/harmonic MIDI clip from your text prompt, then loads a real multi-sampled instrument from the matching category (plucks, keys, basses, pads, …). Polyphonic — chords, arpeggios, basslines, and melodies all work. Use for "add a piano melody", "lay down a warm pad", "write a pluck arp", "give me a sampled bassline" — any request for a REAL / acoustic / sampled pitched instrument. For a synthesized Surge-XT instrument instead, use dsl_generate_midi. Returns the new track id, the chosen category, and the loaded instrument name.',
        inputSchema: {
          type: 'object',
          properties: {
            prompt: {
              type: 'string',
              description:
                'Natural-language description of the instrument and the part (e.g. "warm electric piano chords, gentle swing" or "bright nylon-guitar pluck arpeggio").',
            },
            name: {
              type: 'string',
              description:
                'Optional display name for the new track. Defaults to a timestamped name.',
            },
          },
          required: ['prompt'],
        },
      },
      {
        id: 'shuffle_instrument',
        description:
          'Swap the loaded instrument on an existing instrument track for a different one in the SAME category (e.g. a different pluck). The sample-based counterpart to dsl_shuffle_preset (which only works on Surge-synth tracks, not sample tracks). Use when the user says "try a different piano", "change the pad sound", or "shuffle the bass". Keeps the MIDI; only the loaded instrument changes. The track must have been created by generate_instrument (it needs a category).',
        inputSchema: {
          type: 'object',
          properties: {
            track: {
              type: 'string',
              description:
                'Which instrument track to reshuffle — a track name or natural selector like "the piano" / "pad".',
            },
          },
          required: ['track'],
        },
      },
    ];
  }
}

export default InstrumentGeneratorPlugin;
