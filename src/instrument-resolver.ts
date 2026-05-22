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
 * Implementation: 100% host-mediated FS access (no direct `fs/promises` or
 * `path` imports). The renderer process has Electron context isolation —
 * a direct `import('fs/promises')` returns undefined and silently fails.
 * All FS work goes through `host.listAudioFiles` (recursive sample
 * discovery) and `host.readTextFile` (manifest.json + .txt prompt
 * siblings). Both are IPC proxies to the main process where Node fs is
 * available. This is the same pattern the drum plugin's kit-resolver uses.
 *
 * Discovery strategy:
 *   - `host.listAudioFiles(<root>/instruments, { recursive: true })` returns
 *     all sample files under any category, at any depth.
 *   - Each path is classified by the number of segments below the instruments
 *     root: 2 segments = flat, 3+ = inside a manifest folder.
 *   - For each unique manifest-folder candidate, `host.readTextFile` is called
 *     once; null means "no manifest" (or unreadable) and we skip silently.
 *
 * v0.6 scope: no caching nuance, no hot reload. Call `loadLibrary()` again
 * to re-scan.
 */

import type { PluginHost, InstrumentZone } from '@signalsandsorcery/plugin-sdk';
import type { InstrumentManifest } from './manifest-types';

export interface ResolvedInstrument {
  /** Category folder name, e.g. "plucks" */
  categoryId: string;
  /** Display category from manifest (multi-zone) or title-cased folder name (flat). */
  categoryDisplay: string;
  /** Stable id from manifest, or filename-without-extension for flat instruments. */
  instrumentId: string;
  /** Display name derived from the prompt's first ~40 chars. */
  displayName: string;
  /** Original positive prompt — surfaced in tooltip / detail view. */
  prompt: string;
  /** Zones ready to hand to host.setTrackInstrumentSampler. */
  zones: InstrumentZone[];
  /** Folder absolute path holding this instrument — for diagnostics. */
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
 * root doesn't exist or no audio files were found.
 */
export async function loadLibrary(host: PluginHost, rootPath: string): Promise<InstrumentLibrary> {
  const instrumentsRoot = joinPath(rootPath, 'instruments');

  // Single recursive scan finds every sample under every category, at every depth.
  // listAudioFiles silently returns [] for a missing root — no try/catch needed.
  const samplePaths = await host.listAudioFiles(instrumentsRoot, {
    extensions: ['.wav', '.flac'],
    recursive: true,
  });

  if (samplePaths.length === 0) {
    console.warn(`[instrument-resolver] No samples found under ${instrumentsRoot}; library is empty.`);
    return { categories: [], byCategory: new Map(), all: [] };
  }

  // Group sample paths by classification. Each path is relative to instrumentsRoot:
  //   "plucks/p.wav"                       → flat (2 segments)
  //   "plucks/hand-test/sources/a.wav"     → inside subdir hand-test (4 segments)
  //   "plucks/multi-zone-test/zones/x.wav" → inside subdir multi-zone-test (4 segments)
  //
  // For the flat case we synthesize an instrument inline.
  // For the subdir case we collect (category, subdir) pairs to look up manifests.
  const all: ResolvedInstrument[] = [];
  const manifestFolders = new Set<string>(); // "<category>/<subdir>"

  for (const samplePath of samplePaths) {
    const rel = relativeTo(samplePath, instrumentsRoot);
    if (!rel) continue; // shouldn't happen but defensive
    const segments = rel.split('/').filter(Boolean);
    if (segments.length < 2) continue; // file directly under instruments/, ignore
    if (segments.some(s => s.startsWith('_'))) continue; // _-prefix skip (e.g. _failures/)

    const categoryId = segments[0];

    if (segments.length === 2) {
      // Flat shape: <category>/<filename>
      const filename = segments[1];
      all.push(await buildFlatInstrument(host, instrumentsRoot, categoryId, filename));
    } else {
      // Manifest-folder shape: <category>/<subdir>/...
      manifestFolders.add(`${categoryId}/${segments[1]}`);
    }
  }

  // One read per unique manifest folder.
  for (const folderKey of manifestFolders) {
    const [categoryId, subdir] = folderKey.split('/');
    const manifestDir = joinPath(instrumentsRoot, categoryId, subdir);
    const manifestPath = joinPath(manifestDir, 'manifest.json');
    const raw = await host.readTextFile(manifestPath);
    if (raw === null) {
      console.warn(`[instrument-resolver] Skipping ${manifestPath}: no readable manifest.json`);
      continue;
    }

    let manifest: InstrumentManifest;
    try {
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
      samplePath: resolveZonePath(manifestDir, z.sample),
      rootKey: z.root_midi,
      minKey: z.min_midi,
      maxKey: z.max_midi,
      openEnded: manifest.open_ended,
    }));

    all.push({
      categoryId,
      categoryDisplay: manifest.category_display || titleCase(categoryId),
      instrumentId: manifest.instrument_id,
      displayName: deriveDisplayName(manifest.prompt, manifest.instrument_id),
      prompt: manifest.prompt,
      zones,
      manifestDir,
    });
  }

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

/** Build a single-zone instrument from a flat <category>/<filename> sample. */
async function buildFlatInstrument(
  host: PluginHost,
  instrumentsRoot: string,
  categoryId: string,
  filename: string,
): Promise<ResolvedInstrument> {
  const samplePath = joinPath(instrumentsRoot, categoryId, filename);
  const baseName = stripAudioExt(filename);
  const promptPath = joinPath(instrumentsRoot, categoryId, `${baseName}.txt`);

  const promptRaw = await host.readTextFile(promptPath);
  const prompt = promptRaw ? promptRaw.trim() : '';

  return {
    categoryId,
    categoryDisplay: titleCase(categoryId),
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
    manifestDir: joinPath(instrumentsRoot, categoryId),
  };
}

// ---------- path helpers (string-only; avoids `import('path')` in renderer) ----------

/** Join absolute base + segments with '/' — single platform (Electron on mac/linux/win-posix-paths). */
function joinPath(...segments: string[]): string {
  return segments
    .map((s, i) => (i === 0 ? s.replace(/\/+$/, '') : s.replace(/^\/+|\/+$/g, '')))
    .filter(s => s.length > 0)
    .join('/');
}

/** Return `absPath` relative to `rootPath`, or null if absPath doesn't start with rootPath. */
function relativeTo(absPath: string, rootPath: string): string | null {
  const root = rootPath.replace(/\/+$/, '');
  if (!absPath.startsWith(root + '/')) return null;
  return absPath.slice(root.length + 1);
}

/**
 * Resolve a zone's `sample` field against its manifest folder.
 *   - Absolute path (`/foo/bar.wav`) → returned as-is (hand-test fixtures use this
 *     to reuse existing drum WAVs in stand-in tests)
 *   - Relative path (`zones/060.flac`) → joined onto manifestDir (real pipeline output)
 */
function resolveZonePath(manifestDir: string, sample: string): string {
  if (sample.startsWith('/')) return sample;
  return joinPath(manifestDir, sample);
}

function stripAudioExt(filename: string): string {
  return filename.replace(/\.(wav|flac)$/i, '');
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
