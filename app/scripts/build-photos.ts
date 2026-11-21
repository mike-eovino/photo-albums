// For each album, reads the original photos, extracts EXIF metadata, and writes
// EXIF-free WebP copies plus photos.json into the album's generated/ folder.
// Place assignment happens in the app, so editing places.json never requires
// re-running this script.
// SRS: FR-1, FR-3, FR-4, FR-14, FR-17, FR-21, FR-22, NFR-2, NFR-8.
//
// Edited copies (FR-21): Google Photos saves an edit as "X~2.jpg" with no EXIF.
// Before building, each such copy gets the date, location and camera of its
// original "X.jpg" (or "X.MP.jpg"), the original is deleted, and the copy is
// renamed to "X.jpg", so the photo keeps its id, caption and links.
//
// Tidying (FR-22): after building, places with no photos are removed from
// places.json and captions of photos that no longer exist from captions.json.
//
// Events (FR-1, FR-23): each new visit (a place on a local date) is looked up with
// Claude and web search, and saved to events.json. See events.ts.
//
// Change detection: generated/build-manifest.json records a SHA-256 of each
// original and the image settings used. A photo's WebP copies are rebuilt when
// its original's contents change, when the settings change, or when a copy is
// missing. File timestamps are not used, so replacing an original with an
// older-dated file is still detected. EXIF is re-read from every original on
// every run, so photos.json is always current.
//
// Usage: npm run photos                 (every album that has an originals/ folder)
//        npm run photos -- chennai-2026  (one album)

import { readdir, readFile, writeFile, mkdir, stat, unlink, access, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import exifr from 'exifr';
import sharp from 'sharp';
import { exiftoolPath } from 'exiftool-vendored';
import { type PlaceFile, nearestPlace } from '../src/places.ts';
import { type EventsFile, findVisits, updateEvents } from './events.ts';

const ALBUMS_DIR = path.resolve(import.meta.dirname, '..', '..', 'albums');
const SIZES = { thumbs: 400, display: 1600 } as const;
const WEBP_QUALITY = 80;
const CONCURRENCY = 4;
// Bump when the image pipeline changes in a way SIZES and WEBP_QUALITY don't capture
// (for example a new sharp option), to force every photo to be rebuilt.
const PIPELINE_VERSION = 1;
const SETTINGS_KEY = JSON.stringify({ v: PIPELINE_VERSION, sizes: SIZES, quality: WEBP_QUALITY });
const MANIFEST = 'build-manifest.json';

interface Manifest {
  settings: string;
  photos: Record<string, { file: string; sha256: string }>;
}

interface PhotoRecord {
  id: string;
  file: string;
  takenAt: string | null;
  lat: number | null;
  lon: number | null;
  alt: number | null;
  width: number;
  height: number;
  camera: string | null;
  motion: boolean;
  thumb: string;
  display: string;
  // Changes whenever the WebP copies are rebuilt from different input. The app adds
  // it to image URLs (?v=...) so browsers fetch an edited photo instead of a cached one.
  v: string;
}

// "2026:11:18 11:06:19" + "+05:30" -> "2026-11-18T11:06:19+05:30"
function isoTime(raw: unknown, offset: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const m = raw.match(/^(\d{4}):(\d{2}):(\d{2}) (\d{2}:\d{2}:\d{2})/);
  if (!m) return null;
  const off = typeof offset === 'string' && /^[+-]\d{2}:\d{2}$/.test(offset) ? offset : '';
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}${off}`;
}

function sha256(file: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    createReadStream(file)
      .on('error', reject)
      .on('data', (chunk) => hash.update(chunk))
      .on('end', () => resolve(hash.digest('hex')));
  });
}

async function exists(file: string): Promise<boolean> {
  try {
    await access(file);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

interface ProcessResult {
  record: PhotoRecord;
  sha256: string;
  rebuilt: boolean;
}

async function processPhoto(
  srcDir: string,
  outDir: string,
  file: string,
  prev: Manifest | null,
): Promise<ProcessResult> {
  const src = path.join(srcDir, file);
  const id = file.replace(/(\.MP)?\.jpe?g$/i, '');
  const hash = await sha256(src);

  const tags = await exifr.parse(src, {
    reviveValues: false,
    pick: ['DateTimeOriginal', 'OffsetTimeOriginal', 'Make', 'Model', 'GPSAltitude'],
  });
  const gps = await exifr.gps(src).catch(() => undefined);
  const lat = gps?.latitude ?? null;
  const lon = gps?.longitude ?? null;

  const meta = await sharp(src).metadata();
  const rotated = (meta.orientation ?? 1) >= 5;
  const width = (rotated ? meta.height : meta.width) ?? 0;
  const height = (rotated ? meta.width : meta.height) ?? 0;

  const rel = {
    thumbs: `thumbs/${id}.webp`,
    display: `display/${id}.webp`,
  } satisfies Record<keyof typeof SIZES, string>;

  const before = prev?.photos[id];
  let rebuilt = false;
  const upToDate = prev?.settings === SETTINGS_KEY && before?.file === file && before.sha256 === hash;
  for (const [dir, size] of Object.entries(SIZES) as [keyof typeof SIZES, number][]) {
    const out = path.join(outDir, rel[dir]);
    if (upToDate && (await exists(out))) continue;
    // sharp writes no EXIF/GPS/XMP unless .withMetadata() is called (FR-4).
    await sharp(src)
      .rotate()
      .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toFile(out);
    rebuilt = true;
  }

  const alt = Number(tags?.GPSAltitude);
  const record: PhotoRecord = {
    id,
    file,
    takenAt: isoTime(tags?.DateTimeOriginal, tags?.OffsetTimeOriginal),
    lat,
    lon,
    alt: Number.isFinite(alt) ? Math.round(alt * 10) / 10 : null,
    width,
    height,
    camera: tags?.Model ? String(tags.Model) : null,
    motion: /\.MP\.jpe?g$/i.test(file),
    thumb: rel.thumbs,
    display: rel.display,
    v: createHash('sha256').update(hash).update(SETTINGS_KEY).digest('hex').slice(0, 10),
  };
  return { record, sha256: hash, rebuilt };
}

async function removeStale(dir: string, keep: Set<string>): Promise<number> {
  let removed = 0;
  for (const f of await readdir(dir)) {
    if (f.endsWith('.webp') && !keep.has(f)) {
      await unlink(path.join(dir, f));
      removed++;
    }
  }
  return removed;
}

// "X~2.jpg" or "X.MP~2.jpg" -> base "X". Checked before ORIGINAL_RE, which would also match.
const EDIT_RE = /^(.+?)(\.MP)?~\d+\.jpe?g$/i;
const ORIGINAL_RE = /^(.+?)(\.MP)?\.jpe?g$/i;

/** Merges each edited copy into its original (FR-21). Returns notes for the log. */
async function mergeEdits(srcDir: string): Promise<string[]> {
  const all = await readdir(srcDir);
  const originals = new Map<string, string>();
  const edits = new Map<string, string[]>();
  for (const f of all) {
    const edit = f.match(EDIT_RE);
    if (edit) edits.set(edit[1], [...(edits.get(edit[1]) ?? []), f]);
    else {
      const orig = f.match(ORIGINAL_RE);
      if (orig) originals.set(orig[1], f);
    }
  }
  if (edits.size === 0) return [];

  // Check everything before changing anything.
  for (const [base, list] of edits) {
    if (list.length > 1) {
      throw new Error(
        `${base} has more than one edited copy in originals/ (${list.sort().join(', ')}). ` +
          'Delete all but the one you want, then run again. Nothing was changed.',
      );
    }
  }

  const bin = await exiftoolPath();
  const notes: string[] = [];
  for (const [base, [edit]] of edits) {
    const editPath = path.join(srcDir, edit);
    const target = `${base}.jpg`;
    const targetPath = path.join(srcDir, target);
    const orig = originals.get(base);

    if (!orig) {
      await rename(editPath, targetPath);
      const gps = await exifr.gps(targetPath).catch(() => undefined);
      notes.push(
        `renamed ${edit} to ${target}` +
          (gps ? '' : `. Its original isn't in originals/, so it has no location or time zone`),
      );
      continue;
    }

    const origPath = path.join(srcDir, orig);
    // Copy the original's EXIF (date, time zone, GPS, camera). The edited pixels are
    // already upright, so Orientation is reset to 1, and the original's embedded
    // thumbnail and pixel dimensions are left behind. XMP is not copied, so an
    // edited Motion Photo is not marked as one.
    await promisify(execFile)(bin, [
      '-overwrite_original',
      '-TagsFromFile', origPath,
      '-EXIF:all',
      '--Orientation', '--ThumbnailImage', '--ThumbnailOffset', '--ThumbnailLength',
      '--ExifImageWidth', '--ExifImageHeight',
      '-Orientation#=1',
      editPath,
    ]);

    // Only delete the original once the copy is confirmed to carry its location.
    const [origGps, editGps] = await Promise.all(
      [origPath, editPath].map((f) => exifr.gps(f).catch(() => undefined)),
    );
    if (origGps && editGps?.latitude !== origGps.latitude) {
      throw new Error(`Copying metadata from ${orig} into ${edit} failed. Both files are unchanged except for ${edit}'s metadata.`);
    }
    await unlink(origPath);
    await rename(editPath, targetPath);
    notes.push(`merged ${edit} into ${target}: copied the date, location and camera from ${orig}, then deleted ${orig}`);
  }
  return notes;
}

/** Start and end offsets of each element of the top-level JSON array in `text`. */
function arrayElementSpans(text: string): [number, number][] {
  const spans: [number, number][] = [];
  let depth = 0;
  let inString = false;
  let start = -1;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inString) {
      if (c === '\\') i++;
      else if (c === '"') inString = false;
    } else if (c === '"') inString = true;
    else if (c === '[' || c === '{') {
      if (depth === 1) start = i;
      depth++;
    } else if (c === ']' || c === '}') {
      depth--;
      if (depth === 1) spans.push([start, i + 1]);
    }
  }
  return spans;
}

/** Removes empty places and orphaned captions (FR-22). Returns notes for the log. */
async function tidyAlbumFiles(albumDir: string, photos: PhotoRecord[]): Promise<string[]> {
  const notes: string[] = [];
  const ids = new Set(photos.map((p) => p.id));

  // Skip when no photo has GPS: every place would look empty.
  const placesPath = path.join(albumDir, 'places.json');
  const placesText = await readFile(placesPath, 'utf8').catch(() => null);
  if (placesText && photos.some((p) => p.lat != null)) {
    const places = JSON.parse(placesText) as PlaceFile[];
    const used = new Set(photos.map((p) => nearestPlace(places, p)));
    const empty = places.filter((pl) => !used.has(pl.id));
    const spans = arrayElementSpans(placesText);
    if (empty.length && spans.length === places.length) {
      // Keep the remaining entries exactly as written.
      const kept = spans.filter((_, i) => used.has(places[i].id)).map(([a, b]) => placesText.slice(a, b));
      await writeFile(placesPath, kept.length ? `[\n  ${kept.join(',\n  ')}\n]\n` : '[]\n');
      notes.push(`removed from places.json (no photos left): ${empty.map((pl) => pl.name).join(', ')}`);
    }
  }

  const captionsPath = path.join(albumDir, 'captions.json');
  const captions = await readJson<Record<string, string>>(captionsPath);
  if (captions) {
    const orphans = Object.keys(captions).filter((id) => !ids.has(id));
    if (orphans.length) {
      for (const id of orphans) delete captions[id];
      await writeFile(captionsPath, JSON.stringify(captions, null, 2) + '\n');
      notes.push(`removed ${orphans.length} caption(s) of deleted photos from captions.json`);
    }
  }

  const cover = (await readJson<{ coverPhotoId?: string }>(path.join(albumDir, 'album.json')))?.coverPhotoId;
  if (cover && !ids.has(cover)) {
    notes.push(`WARNING: album.json's coverPhotoId ${cover} no longer exists; the first photo is used instead`);
  }

  const noCaption = photos.filter((p) => !captions?.[p.id]).map((p) => p.id);
  if (noCaption.length) notes.push(`no caption yet: ${noCaption.join(', ')}`);
  return notes;
}

/** Looks up significant events for new visits (FR-23). Returns notes for the log. */
async function buildEvents(albumDir: string, photos: PhotoRecord[]): Promise<string[]> {
  const places = await readJson<PlaceFile[]>(path.join(albumDir, 'places.json'));
  if (!places?.length) return [];
  const album = await readJson<{ localLanguage?: { name: string } }>(path.join(albumDir, 'album.json'));
  const eventsPath = path.join(albumDir, 'events.json');
  // A hand-edited events.json with a typo must stop the build: treating it as empty
  // would look up (and pay for) every visit again and overwrite the owner's edits.
  const eventsText = await readFile(eventsPath, 'utf8').catch(() => null);
  let existing: EventsFile = {};
  if (eventsText !== null) {
    try {
      existing = JSON.parse(eventsText) as EventsFile;
    } catch (err) {
      throw new Error(
        `${eventsPath} is not valid JSON (${(err as Error).message}). Fix it and run again. ` +
          'Photos and photos.json were updated; no events were looked up.',
      );
    }
  }
  const visits = findVisits(places, photos);
  const { file, notes, changed } = await updateEvents(existing, visits, album?.localLanguage?.name ?? 'English');
  if (changed) await writeFile(eventsPath, JSON.stringify(file, null, 2) + '\n');
  return notes;
}

async function buildAlbum(album: string) {
  const started = Date.now();
  const albumDir = path.join(ALBUMS_DIR, album);
  const srcDir = path.join(albumDir, 'originals');
  const outDir = path.join(albumDir, 'generated');
  const notes = await mergeEdits(srcDir);
  const files = (await readdir(srcDir)).filter((f) => /\.jpe?g$/i.test(f)).sort();
  if (files.length === 0) throw new Error(`No JPEGs found in ${srcDir}`);

  for (const dir of Object.keys(SIZES)) await mkdir(path.join(outDir, dir), { recursive: true });

  // The previous photos.json says which photos the album had before this run;
  // the manifest says what each one was built from.
  const prevIds = new Set(
    ((await readJson<{ photos: { id: string }[] }>(path.join(outDir, 'photos.json')))?.photos ?? []).map((p) => p.id),
  );
  const prevManifest = await readJson<Manifest>(path.join(outDir, MANIFEST));

  const results: ProcessResult[] = [];
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    results.push(...(await Promise.all(batch.map((f) => processPhoto(srcDir, outDir, f, prevManifest)))));
    process.stdout.write(`\r${album}: ${Math.min(i + CONCURRENCY, files.length)}/${files.length}`);
  }
  process.stdout.write('\n');

  const photos = results.map((r) => r.record);

  photos.sort((a, b) => (a.takenAt ?? '').localeCompare(b.takenAt ?? '') || a.id.localeCompare(b.id));

  const keep = new Set(photos.map((p) => `${p.id}.webp`));
  let stale = 0;
  for (const dir of Object.keys(SIZES)) stale += await removeStale(path.join(outDir, dir), keep);

  await writeFile(path.join(outDir, 'photos.json'), JSON.stringify({ photos }, null, 2) + '\n');
  const manifest: Manifest = { settings: SETTINGS_KEY, photos: {} };
  for (const r of [...results].sort((a, b) => a.record.id.localeCompare(b.record.id))) {
    manifest.photos[r.record.id] = { file: r.record.file, sha256: r.sha256 };
  }
  await writeFile(path.join(outDir, MANIFEST), JSON.stringify(manifest, null, 2) + '\n');

  const ids = new Set(photos.map((p) => p.id));
  const added = results.filter((r) => !prevIds.has(r.record.id)).length;
  const updated = results.filter((r) => prevIds.has(r.record.id) && r.rebuilt).length;
  const unchanged = results.filter((r) => prevIds.has(r.record.id) && !r.rebuilt).length;
  const removed = [...prevIds].filter((id) => !ids.has(id)).length;
  const secs = ((Date.now() - started) / 1000).toFixed(1);
  console.log(
    `${album}: ${added} added, ${updated} updated, ${removed} removed, ${unchanged} unchanged ` +
      `(${photos.length} photos, ${secs} s)` +
      (stale ? `; deleted ${stale} stale image files` : ''),
  );
  notes.push(...(await tidyAlbumFiles(albumDir, photos)));
  notes.push(...(await buildEvents(albumDir, photos)));
  const missing = photos.filter((p) => p.lat == null).map((p) => p.id);
  if (missing.length) notes.push(`no GPS, so not on the map: ${missing.join(', ')}`);
  for (const n of notes) console.log(`  ${n}`);
}

async function main() {
  let albums = process.argv.slice(2);
  if (albums.length === 0) {
    const entries = await readdir(ALBUMS_DIR, { withFileTypes: true });
    albums = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try {
        if ((await stat(path.join(ALBUMS_DIR, e.name, 'originals'))).isDirectory()) albums.push(e.name);
      } catch {
        // no originals/ on this machine: keep the committed generated/ files as they are
      }
    }
  }
  if (albums.length === 0) throw new Error(`No album folders with an originals/ folder in ${ALBUMS_DIR}`);
  for (const album of albums) await buildAlbum(album);
}

main().catch((err) => {
  console.error(process.env.DEBUG || !(err instanceof Error) ? err : `\nError: ${err.message}`);
  process.exit(1);
});
