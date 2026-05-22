/**
 * TypeScript shape of `manifest.json` files written by the pitched-sample
 * pipeline (`sas-sample-generator/scripts/enrich_pitched.py`).
 *
 * One folder under `<sample-root>/instruments/<category>/<instrument-id>/`
 * holds a manifest plus the WAV/FLAC files it references. Zone paths are
 * RELATIVE to the manifest's directory; the resolver absolutizes them
 * before handing zones to the engine.
 *
 * v1 invariants:
 *   - `zones` is disjoint and ordered low->high by `root_midi`
 *   - `loop` is always null (Tracktion SamplerPlugin has no loop API)
 *   - `open_ended` mirrors per-zone playback behaviour
 */
export interface InstrumentManifestZone {
  /** Relative path from the manifest file, e.g. "zones/060.flac". */
  sample: string;
  root_midi: number;
  min_midi: number;
  max_midi: number;
}

export interface InstrumentManifestSource {
  file: string;
  target_pitch_midi: number;
  measured_pitch_midi?: number;
  measured_pitch_cents_offset?: number;
  pitch_confidence?: number;
  pitch_correction_applied_cents?: number;
  polyphony_check?: string;
  onset_ms?: number;
  sustain_quality?: number;
  loudness_lufs?: number;
  rms_dbfs?: number;
  duration_seconds?: number;
  raw_path?: string;
  seed?: number;
  variant_index?: number;
}

export interface InstrumentManifestLoop {
  start_seconds: number;
  end_seconds: number;
  crossfade_ms: number;
}

export interface InstrumentManifest {
  schema_version: 1;
  instrument_id: string;
  category_id: string;
  category_display: string;
  prompt: string;
  negative_prompt?: string;
  model?: string;
  generated_at?: string;
  gate_version?: string;
  enrich_version?: string;
  sources: InstrumentManifestSource[];
  /** v1 always null — see Tracktion limitation note in the pipeline plan. */
  loop: InstrumentManifestLoop | null;
  open_ended: boolean;
  zones: InstrumentManifestZone[];
  channels?: number;
  sample_rate?: number;
  bit_depth?: number;
}
