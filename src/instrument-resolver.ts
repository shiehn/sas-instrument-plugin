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

import { scorePromptMatch, pickTopKWeighted } from '@signalsandsorcery/plugin-sdk';
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
 * Options for a query-aware instrument pick. Passing a bare
 * `ReadonlySet<string>` (the historical second argument) is still accepted
 * and treated as `excludeIds`, so existing callers keep working unchanged.
 */
export interface PickInstrumentOptions {
  /** Shuffle history — instrumentIds to skip. */
  excludeIds?: ReadonlySet<string>;
  /**
   * Free-text intent ("warm vintage upright piano"). When supplied AND the
   * instruments carry non-empty prompts, the pick is biased toward the
   * closest-matching instrument (top-k weighted). With no query, empty
   * prompts (legacy packs), or no token overlap, selection stays uniform
   * random — identical to the historical behavior.
   */
  query?: string;
  /** Injectable RNG in [0, 1) for deterministic tests (default Math.random). */
  rng?: () => number;
}

/**
 * Pick a ResolvedInstrument from the given category, excluding any whose
 * `instrumentId` is in `excludeIds`. Returns null when the filtered pool is
 * empty (either category empty OR caller has used every entry — the panel
 * uses the null signal to reset its shuffle history and call again with an
 * empty exclude set), or if the category is unknown.
 *
 * The second argument is either a `ReadonlySet<string>` of instrumentIds to
 * exclude (the historical shape) or a {@link PickInstrumentOptions} object
 * that can additionally carry a `query` to bias the pick semantically.
 */
export function pickInstrument(
  library: InstrumentLibrary,
  categoryId: string,
  options?: ReadonlySet<string> | PickInstrumentOptions,
): ResolvedInstrument | null {
  const { excludeIds, query, rng = Math.random } =
    options instanceof Set
      ? ({ excludeIds: options as ReadonlySet<string> } as PickInstrumentOptions)
      : ((options as PickInstrumentOptions) ?? {});

  const pool = library.byCategory.get(categoryId);
  if (!pool || pool.length === 0) return null;
  const filtered = excludeIds && excludeIds.size > 0
    ? pool.filter(p => !excludeIds.has(p.instrumentId))
    : pool;
  if (filtered.length === 0) return null;

  // Semantic pick: bias toward the instrument whose prompt best matches the
  // query. No query, empty prompts (legacy packs), or no token overlap →
  // falls through to the uniform-random pick below.
  const trimmedQuery = query?.trim();
  if (trimmedQuery) {
    const scores = scorePromptMatch(trimmedQuery, filtered.map(inst => inst.prompt));
    const maxScore = scores.reduce((m, s) => Math.max(m, s), 0);
    if (maxScore > 0) {
      const picked = pickTopKWeighted(
        filtered.map((inst, i) => ({ item: inst, score: scores[i], key: inst.instrumentId })),
        { rng },
      );
      if (picked) return picked;
    }
  }

  const idx = Math.floor(rng() * filtered.length);
  return filtered[idx];
}

/**
 * Module-level cache of the loaded library, keyed by categoriesRoot and
 * validated against the pack's `_pack-version.json` version. The instrument
 * library is project-INDEPENDENT (the pack is global) and expensive to scan —
 * v3 is 28 categories / ~5,475 manifest folders over ~77k files. Without this
 * cache the full scan re-ran on EVERY generate / shuffle (a multi-second stall
 * each time); with it only the first load after launch — or a pack-version
 * change — pays the cost. Concurrent first-loads are deduped via the promise.
 */
const libraryCache = new Map<string, { version: string; promise: Promise<InstrumentLibrary> }>();

/**
 * Drop cached libraries (all, or just one root). A pack version bump
 * invalidates on its own; call this after a re-install at the SAME version.
 */
export function invalidateInstrumentLibraryCache(root?: string): void {
  if (root) libraryCache.delete(root);
  else libraryCache.clear();
}

/** Read the installed pack's version marker (cheap — one small file). '' if absent. */
async function readPackVersion(host: PluginHost, root: string): Promise<string> {
  try {
    const raw = await host.readTextFile(joinPath(root, '_pack-version.json'));
    if (!raw) return '';
    const v = (JSON.parse(raw) as { version?: unknown }).version;
    return typeof v === 'string' ? v : '';
  } catch {
    return '';
  }
}

/** Run `fn` over `items` with at most `limit` concurrent calls, preserving order. */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    for (let i = next++; i < items.length; i = next++) {
      results[i] = await fn(items[i], i);
    }
  };
  const n = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: n }, () => worker()));
  return results;
}

/**
 * Load a library from `categoriesRoot` — a directory whose immediate children
 * are category folders (plucks/, basses/, pianos/, ...). Returns an empty
 * library if the root doesn't exist or no audio files were found.
 *
 * The result is CACHED per-root and reused until the pack's `_pack-version.json`
 * version changes, so repeated generate/shuffle calls don't re-scan thousands
 * of manifests. Phase 1.1: the pack zip structures its payload as
 * `<category>/<id>/...` so the install root IS the categoriesRoot.
 */
export async function loadLibrary(host: PluginHost, categoriesRoot: string): Promise<InstrumentLibrary> {
  const version = await readPackVersion(host, categoriesRoot);
  const cached = libraryCache.get(categoriesRoot);
  if (cached && version !== '' && cached.version === version) {
    return cached.promise;
  }

  const promise = buildLibrary(host, categoriesRoot);
  // Only cache against a real version marker; evict a failed build so the next
  // call retries instead of caching an empty/partial library forever.
  if (version !== '') {
    libraryCache.set(categoriesRoot, { version, promise });
    promise.catch(() => {
      const cur = libraryCache.get(categoriesRoot);
      if (cur && cur.promise === promise) libraryCache.delete(categoriesRoot);
    });
  }
  return promise;
}

/** The actual filesystem scan + manifest parse (uncached; see {@link loadLibrary}). */
async function buildLibrary(host: PluginHost, instrumentsRoot: string): Promise<InstrumentLibrary> {
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
  const flatSpecs: { categoryId: string; filename: string }[] = [];
  const manifestFolders = new Set<string>(); // "<category>/<subdir>"

  for (const samplePath of samplePaths) {
    const rel = relativeTo(samplePath, instrumentsRoot);
    if (!rel) continue; // shouldn't happen but defensive
    const segments = rel.split('/').filter(Boolean);
    if (segments.length < 2) continue; // file directly under instruments/, ignore
    if (segments.some(s => s.startsWith('_'))) continue; // _-prefix skip (e.g. _failures/)

    const categoryId = segments[0];

    if (segments.length === 2) {
      // Flat shape: <category>/<filename> — collect; built in parallel below.
      flatSpecs.push({ categoryId, filename: segments[1] });
    } else {
      // Manifest-folder shape: <category>/<subdir>/...
      manifestFolders.add(`${categoryId}/${segments[1]}`);
    }
  }

  // Read manifests + build flat instruments with bounded concurrency — a v3 cold
  // load is ~5,475 manifest reads; sequential awaits made it a multi-second stall.
  const READ_CONCURRENCY = 96;
  const all: ResolvedInstrument[] = await mapWithConcurrency(
    flatSpecs,
    READ_CONCURRENCY,
    (spec) => buildFlatInstrument(host, instrumentsRoot, spec.categoryId, spec.filename),
  );

  // One read per unique manifest folder — bounded-concurrent (see READ_CONCURRENCY).
  const built = await mapWithConcurrency(
    Array.from(manifestFolders),
    READ_CONCURRENCY,
    async (folderKey): Promise<ResolvedInstrument | null> => {
      const [categoryId, subdir] = folderKey.split('/');
      const manifestDir = joinPath(instrumentsRoot, categoryId, subdir);
      const manifestPath = joinPath(manifestDir, 'manifest.json');
      const raw = await host.readTextFile(manifestPath);
      if (raw === null) {
        console.warn(`[instrument-resolver] Skipping ${manifestPath}: no readable manifest.json`);
        return null;
      }

      let manifest: InstrumentManifest;
      try {
        manifest = JSON.parse(raw) as InstrumentManifest;
      } catch (err) {
        console.warn(`[instrument-resolver] Skipping ${manifestPath}: ${(err as Error).message}`);
        return null;
      }

      if (manifest.schema_version !== 1 || !Array.isArray(manifest.zones) || manifest.zones.length === 0) {
        console.warn(`[instrument-resolver] Skipping ${manifestPath}: invalid schema or no zones`);
        return null;
      }

      const zones: InstrumentZone[] = manifest.zones.map(z => ({
        samplePath: resolveZonePath(manifestDir, z.sample),
        rootKey: z.root_midi,
        minKey: z.min_midi,
        maxKey: z.max_midi,
        openEnded: manifest.open_ended,
      }));

      return {
        categoryId,
        categoryDisplay: manifest.category_display || titleCase(categoryId),
        instrumentId: manifest.instrument_id,
        displayName: deriveDisplayName(manifest.prompt, manifest.instrument_id),
        prompt: manifest.prompt,
        zones,
        manifestDir,
      };
    },
  );
  for (const inst of built) {
    if (inst) all.push(inst);
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

// Phase 1.1: DEFAULT_SAMPLE_ROOT removed — the panel now resolves the install
// root at runtime via `host.getSamplePackRoot('sas-instrument-pack')`. See
// PackDownloadService + sample-packs.ts for the distribution model.
