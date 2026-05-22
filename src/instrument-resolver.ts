/**
 * Instrument resolver — scans the configured pitched-sample library and
 * returns the list of available instruments, grouped by category.
 *
 * Two library shapes coexist under `<root>/instruments/<category>/`:
 *
 *   1. Manifest folders (Phase 1.0+ pipeline output) — multi-zone instruments
 *        <category>/<instrument-id>/
 *          ├── manifest.json
 *          ├── sources/<root>.wav
 *          ├── zones/<midi>.flac
 *          └── prompt.txt
 *
 *   2. Flat WAV/FLAC files (Phase 0.6, drum-pipeline-style output) — single-
 *      zone instruments synthesized on the fly with rootKey=60, range 0-127.
 *        <category>/<id>.wav  + sibling <id>.txt (prompt)
 *      Tracktion's sampler pitch-shifts to the played note for free, so
 *      polyphonic pitched playback works without any pipeline work — these
 *      are intentionally cheaper and lower-quality than multi-zone instruments
 *      (no pitch correction, no formant-preserved pre-rendering at extremes).
 *
 * The resolver dispatches per-entry: `Dirent.isDirectory()` → shape 1,
 * `Dirent.isFile()` with .wav/.flac extension → shape 2. Both contribute
 * to the same per-category `ResolvedInstrument[]` list returned to the UI.
 *
 * v0.6 scope: read both shapes, list them, expose zone arrays. No caching
 * nuance, no hot reload — call `loadLibrary()` again to re-scan.
 */

import type { PluginHost, InstrumentZone } from '@signalsandsorcery/plugin-sdk';
import type { InstrumentManifest } from './manifest-types';

export interface ResolvedInstrument {
  /** Category folder name, e.g. "plucks" */
  categoryId: string;
  /** Display category from manifest, e.g. "Plucks" */
  categoryDisplay: string;
  /** Stable id from manifest, e.g. "plucks-bright-warm-a3f2e8c1" */
  instrumentId: string;
  /** Display name derived from the prompt's first ~40 chars */
  displayName: string;
  /** Original positive prompt — surfaced in tooltip / detail view */
  prompt: string;
  /** Zones ready to hand to host.setTrackInstrumentSampler */
  zones: InstrumentZone[];
  /** Manifest folder absolute path (for diagnostics) */
  manifestDir: string;
}

export interface InstrumentLibrary {
  /** All categories that contain at least one instrument, in alphabetical order. */
  categories: string[];
  /** Map of categoryId -> instruments, sorted by display name. */
  byCategory: Map<string, ResolvedInstrument[]>;
  /** Flat list, useful for global search. */
  all: ResolvedInstrument[];
}

/**
 * Load a library from `<root>/instruments`. Returns an empty library if the
 * root doesn't exist; logs a warning if scanning errors out.
 *
 * `host.listAudioFiles` doesn't read JSON, so the resolver shells out to the
 * preload-exposed fs APIs. The walking-skeleton uses dynamic `await import('fs/promises')`
 * inside the plugin renderer process, which works because builtins run in
 * the main-process renderer where node-integration is enabled.
 */
export async function loadLibrary(host: PluginHost, rootPath: string): Promise<InstrumentLibrary> {
  const fs = await import('fs/promises');
  const path = await import('path');

  const instrumentsRoot = path.join(rootPath, 'instruments');
  const all: ResolvedInstrument[] = [];

  let categoryEntries: import('fs').Dirent[];
  try {
    categoryEntries = await fs.readdir(instrumentsRoot, { withFileTypes: true });
  } catch (err) {
    // Missing root is the expected pre-generation state — return empty.
    console.warn(`[instrument-resolver] No instruments root at ${instrumentsRoot}; library is empty.`);
    return { categories: [], byCategory: new Map(), all: [] };
  }

  for (const catEntry of categoryEntries) {
    if (!catEntry.isDirectory() || catEntry.name.startsWith('_')) continue;
    const catDir = path.join(instrumentsRoot, catEntry.name);

    let instrumentEntries: import('fs').Dirent[];
    try {
      instrumentEntries = await fs.readdir(catDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const instEntry of instrumentEntries) {
      if (instEntry.name.startsWith('_')) continue;

      if (instEntry.isDirectory()) {
        // Shape 1: manifest folder (Phase 1.0+ multi-zone instrument)
        const instDir = path.join(catDir, instEntry.name);
        const manifestPath = path.join(instDir, 'manifest.json');

        let manifest: InstrumentManifest;
        try {
          const raw = await fs.readFile(manifestPath, 'utf8');
          manifest = JSON.parse(raw) as InstrumentManifest;
        } catch (err) {
          console.warn(`[instrument-resolver] Skipping ${manifestPath}: ${(err as Error).message}`);
          continue;
        }

        if (manifest.schema_version !== 1 || !Array.isArray(manifest.zones) || manifest.zones.length === 0) {
          console.warn(`[instrument-resolver] Skipping ${manifestPath}: invalid schema or no zones`);
          continue;
        }

        const zones: InstrumentZone[] = manifest.zones.map(z => ({
          // path.resolve respects absolute paths (`/Users/...` wins over instDir)
          // and joins relative paths (`zones/060.flac` → `<instDir>/zones/060.flac`).
          // Real pipeline output is relative; the hand-crafted multi-zone test
          // uses absolute paths to reuse existing drum WAVs.
          samplePath: path.resolve(instDir, z.sample),
          rootKey: z.root_midi,
          minKey: z.min_midi,
          maxKey: z.max_midi,
          openEnded: manifest.open_ended,
        }));

        all.push({
          categoryId: catEntry.name,
          categoryDisplay: manifest.category_display || catEntry.name,
          instrumentId: manifest.instrument_id,
          displayName: deriveDisplayName(manifest.prompt, manifest.instrument_id),
          prompt: manifest.prompt,
          zones,
          manifestDir: instDir,
        });
        continue;
      }

      if (instEntry.isFile()) {
        // Shape 2: flat WAV/FLAC at category root (Phase 0.6 single-zone synthesized).
        // Filename without extension is the instrument id; sibling .txt holds the
        // prompt. We synthesize one zone covering the full keyboard rooted at C4
        // (60); Tracktion handles pitch-shift on note != rootKey. No pitch
        // correction, no formant preservation — quality degrades at extremes.
        const lower = instEntry.name.toLowerCase();
        if (!lower.endsWith('.wav') && !lower.endsWith('.flac')) continue;

        const samplePath = path.join(catDir, instEntry.name);
        const baseName = instEntry.name.replace(/\.(wav|flac)$/i, '');
        const promptPath = path.join(catDir, `${baseName}.txt`);

        let prompt = '';
        try {
          prompt = (await fs.readFile(promptPath, 'utf8')).trim();
        } catch {
          // No sibling .txt is fine — fall back to filename for display.
        }

        all.push({
          categoryId: catEntry.name,
          categoryDisplay: titleCase(catEntry.name),
          instrumentId: baseName,
          displayName: deriveDisplayName(prompt, baseName),
          prompt,
          zones: [{
            samplePath,
            rootKey: 60,
            minKey: 0,
            maxKey: 127,
            openEnded: false,
          }],
          manifestDir: catDir,
        });
      }
    }
  }

  // Note: host.listAudioFiles is unused here — we intentionally use fs
  // directly because we need JSON-parsing, not just file-walking. Keep the
  // host parameter in the signature so future versions can switch to a
  // host-mediated FS without changing call sites.
  void host;

  const byCategory = new Map<string, ResolvedInstrument[]>();
  for (const inst of all) {
    const list = byCategory.get(inst.categoryId) ?? [];
    list.push(inst);
    byCategory.set(inst.categoryId, list);
  }
  for (const list of byCategory.values()) {
    list.sort((a, b) => a.displayName.localeCompare(b.displayName));
  }
  const categories = Array.from(byCategory.keys()).sort();

  console.log(
    `[instrument-resolver] Loaded ${all.length} instruments across ${categories.length} categories from ${instrumentsRoot}`
  );

  return { categories, byCategory, all };
}

/**
 * Turn a prompt into a short display label. Prompts are sentence-like
 * ("bright warm acoustic guitar pluck single note, soft attack..."); we
 * take the first ~40 chars up to a comma so the dropdown is scannable.
 */
function deriveDisplayName(prompt: string, fallbackId: string): string {
  if (!prompt) return fallbackId;
  const firstClause = prompt.split(/[,;]/)[0]?.trim() ?? prompt;
  if (firstClause.length <= 40) return firstClause;
  return firstClause.slice(0, 37).trimEnd() + '...';
}

/** "plucks" -> "Plucks". Used for flat-shape categoryDisplay when no manifest gives one. */
function titleCase(s: string): string {
  if (!s) return s;
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/**
 * The walking-skeleton scans this hardcoded path. The pipeline's enrich
 * step writes to `<repo>/outputs/instruments/<cat>/<id>/`. For local
 * iteration on a dev box, the easiest path is to symlink:
 *
 *   ln -s /Users/<you>/sas-platform/sas-sample-generator/outputs \
 *         /Users/<you>/Downloads/outputs
 *
 * which lines up with the drums plugin's existing `DEFAULT_SAMPLE_ROOT`.
 * A real release will move this under app-data or a user-configurable
 * preference; the manifest contract is already version-tagged so the
 * resolver can grow without breaking existing libraries.
 */
export const DEFAULT_SAMPLE_ROOT = '/Users/stevehiehn/Downloads/outputs';
