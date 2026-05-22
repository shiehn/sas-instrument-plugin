/**
 * @signalsandsorcery/instrument-generator — Built-in Instrument Generator Plugin
 *
 * Walking-skeleton plugin for pitched, polyphonic sample-based instruments.
 * Sister to drum-generator but uses the multi-zone sampler path
 * (host.setTrackInstrumentSampler) so MIDI notes are pitch-shifted across
 * a chromatic range and zone overlaps are disallowed.
 *
 * v0.5 scope: scan an instrument library produced by the pitched-sample
 * pipeline, let the user pick a category + instrument, load it on a
 * track. No LLM-driven MIDI generation yet — that lives in v1.x once
 * the audio path is proven end-to-end.
 */

import type { ComponentType } from 'react';
import type {
  GeneratorPlugin,
  PluginHost,
  PluginUIProps,
  PluginSettingsSchema,
  MusicalContext,
} from '@signalsandsorcery/plugin-sdk';
import { InstrumentGeneratorPanel } from './InstrumentGeneratorPanel';

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
    // No-op until v1.x adds LLM-driven generation
  }
}

export default InstrumentGeneratorPlugin;
