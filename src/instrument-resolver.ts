/**
 * Instrument resolver — scans the configured pitched-sample library and
 * returns the list of available instruments, grouped by category.
 *
 * Library layout (written by sas-sample-generator/scripts/enrich_pitched.py):
 *
 *   <root>/instruments/<category>/<instrument-id>/
 *     ├── manifest.json
 *     ├── sources/<root>.wav
 *     ├── zones/<midi>.flac
 *     └── prompt.txt
 *
 * Unlike the drums plugin (which scans flat directories of WAVs), this
 * resolver uses the manifest as the unit of an instrument — categories
 * are not encoded in filenames, and zones come from the manifest rather
 * than from file naming. That's because every pitched instrument is a
 * SET of related samples that only make sense together.
 *
 * v0.5 walking-skeleton scope: read manifests, list them, expose
 * absolute zone paths. No caching nuance, no hot reload — call
 * `loadLibrary()` again to re-scan.
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
      if (!instEntry.isDirectory() || instEntry.name.startsWith('_')) continue;
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
