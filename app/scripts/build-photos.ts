// For each album, reads the original photos, extracts EXIF metadata, and writes
// EXIF-free WebP copies plus photos.json into the album's generated/ folder.
// Place assignment happens in the app, so editing places.json never requires
// re-running this script.
// SRS: FR-1, FR-3, FR-4, FR-14, FR-17, FR-21, FR-22, FR-24, FR-25, NFR-2, NFR-8.
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
// Overrides (FR-25): albums/<id>/overrides.json gives a photo a position or capture
// time by hand, either written out or copied from another photo. For photos taken
// without a GPS fix, whose GPS jumped, or with no EXIF. The originals are not changed.
//
// Videos (FR-24): each video in originals/ gets a 1080p, 30 fps H.264 web copy with
// no metadata (generated/videos/), and a still frame becomes its thumbnail and
// display image. Date, location and length come from the video's own metadata.
// Converting needs ffmpeg, from the ffmpeg-static package.
//
// Change detection: generated/build-manifest.json records a SHA-256 of each
// original and the image settings used. A photo's WebP copies are rebuilt when
// its original's contents change, when the settings change, or when a copy is
// missing. File timestamps are not used, so replacing an original with an
// older-dated file is still detected. EXIF is re-read from every original on
// every run, so photos.json is always current.
//
// Usage: npm run photos                          (every album that has an originals/ folder)
//        npm run photos -- chennai-2026           (one album)
//        npm run photos -- chennai-2026 --events  (also look up events for new visits; costs money)

import { readdir, readFile, writeFile, mkdir, stat, unlink, access, rename } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import exifr from 'exifr';
import sharp from 'sharp';
import { exiftool, exiftoolPath, ExifDateTime } from 'exiftool-vendored';
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

// Web copies of videos (FR-24). The short side is scaled to 1080 px (1080p).
const VIDEO = { shortSide: 1080, fps: 30, crf: 23, maxrate: '5M', bufsize: '10M', audio: '128k' } as const;
// A web copy over this size would be refused by GitHub (100 MB per file).
const VIDEO_MAX_BYTES = 95_000_000;
const VIDEO_SETTINGS_KEY = JSON.stringify({ v: 1, video: VIDEO, sizes: SIZES, quality: WEBP_QUALITY });
const VIDEO_RE = /\.(mp4|mov)$/i;

interface Manifest {
  settings: string;
  videoSettings?: string;
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
  locationSetByHand?: true; // from overrides.json (FR-25)
  dateSetByHand?: true; // from overrides.json (FR-25)
  video?: string; // videos only: web copy, relative to generated/
  duration?: number; // videos only: seconds
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

let ffmpegBin: string | undefined;
async function ffmpeg(args: string[]): Promise<Buffer> {
  // Loaded only when an album has videos, so photo-only builds don't need it.
  const mod = ffmpegBin ? null : await import('ffmpeg-static').catch(() => null);
  const bin = (ffmpegBin ??= mod?.default ?? undefined);
  if (!bin) throw new Error('Converting videos needs the ffmpeg-static package. In app/, run: npm install');
  const { stdout } = await promisify(execFile)(bin, ['-hide_banner', '-loglevel', 'error', ...args], {
    encoding: 'buffer',
    maxBuffer: 256 * 1024 * 1024,
  });
  return stdout;
}

const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);

async function processVideo(
  srcDir: string,
  outDir: string,
  file: string,
  prev: Manifest | null,
): Promise<ProcessResult> {
  const src = path.join(srcDir, file);
  const id = file.replace(VIDEO_RE, '');
  const hash = await sha256(src);
  const tags = await exiftool.read(src);

  const duration = Number(tags.Duration) || 0;
  // Pixel phones record the time a video ends; subtract its length to get the start.
  // exiftool-vendored works out the local time zone from the GPS position.
  const end = tags.CreateDate instanceof ExifDateTime ? tags.CreateDate.toDateTime() : undefined;
  const start = end?.isValid ? end.minus({ milliseconds: Math.round(duration * 1000) }) : undefined;
  const takenAt = start ? start.toFormat("yyyy-MM-dd'T'HH:mm:ssZZ") : null;
  const lat = typeof tags.GPSLatitude === 'number' ? tags.GPSLatitude : null;
  const lon = typeof tags.GPSLongitude === 'number' ? tags.GPSLongitude : null;
  const alt = Number(tags.GPSAltitude);

  // Upright size, then scaled so the short side is at most VIDEO.shortSide.
  const turned = [90, 270].includes(Math.abs(Number(tags.Rotation) || 0));
  const w0 = Number(turned ? tags.ImageHeight : tags.ImageWidth) || 0;
  const h0 = Number(turned ? tags.ImageWidth : tags.ImageHeight) || 0;
  if (!w0 || !h0) throw new Error(`Couldn't read the size of ${file}`);
  const f = Math.min(1, VIDEO.shortSide / Math.min(w0, h0));
  const width = even(w0 * f);
  const height = even(h0 * f);

  const rel = { video: `videos/${id}.mp4`, thumbs: `thumbs/${id}.webp`, display: `display/${id}.webp` };
  const out = (k: keyof typeof rel) => path.join(outDir, rel[k]);
  const before = prev?.photos[id];
  const upToDate = prev?.videoSettings === VIDEO_SETTINGS_KEY && before?.file === file && before.sha256 === hash;
  let rebuilt = false;

  if (!upToDate || !(await exists(out('video')))) {
    process.stdout.write(`\n  converting ${file} (${Math.round(duration)} s)...`);
    // Write to a temporary name first, so an interrupted run never leaves a half-written copy.
    const tmp = out('video').replace(/\.mp4$/, '.part.mp4');
    await ffmpeg([
      '-y', '-i', src,
      '-map', '0:v:0', '-map', '0:a:0?', // just the picture and sound
      '-map_metadata', '-1', '-map_metadata:s', '-1', '-map_chapters', '-1', // no date, GPS or camera (FR-4)
      '-vf', `scale=${width}:${height},fps=${VIDEO.fps}`,
      '-c:v', 'libx264', '-preset', 'slow', '-crf', String(VIDEO.crf),
      '-maxrate', VIDEO.maxrate, '-bufsize', VIDEO.bufsize,
      '-profile:v', 'high', '-pix_fmt', 'yuv420p',
      '-c:a', 'aac', '-b:a', VIDEO.audio,
      '-movflags', '+faststart', // playback can start before the whole file arrives
      tmp,
    ]);
    const leaked = await exiftool.read(tmp);
    if (leaked.GPSLatitude != null || leaked.GPSCoordinates != null) {
      await unlink(tmp);
      throw new Error(`The web copy of ${file} still had a location in it, so it was deleted.`);
    }
    const size = (await stat(tmp)).size;
    if (size > VIDEO_MAX_BYTES) {
      await unlink(tmp);
      throw new Error(
        `The web copy of ${file} is ${Math.round(size / 1e6)} MB, over GitHub's limit. Trim the video and run again.`,
      );
    }
    await rename(tmp, out('video'));
    rebuilt = true;
  }

  if (rebuilt || !(await exists(out('thumbs'))) || !(await exists(out('display')))) {
    // A frame 1 s in (or halfway, for very short clips) becomes the thumbnail and poster.
    const frame = await ffmpeg([
      '-ss', String(Math.min(1, duration / 2)), '-i', out('video'),
      '-frames:v', '1', '-f', 'image2pipe', '-c:v', 'png', '-',
    ]);
    for (const [dir, size] of Object.entries(SIZES) as [keyof typeof SIZES, number][]) {
      await sharp(frame)
        .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
        .webp({ quality: WEBP_QUALITY })
        .toFile(out(dir));
    }
    rebuilt = true;
  }

  const record: PhotoRecord = {
    id,
    file,
    takenAt,
    lat,
    lon,
    alt: Number.isFinite(alt) ? Math.round(alt * 10) / 10 : null,
    width,
    height,
    camera: typeof tags.Model === 'string' ? tags.Model : null,
    motion: false,
    thumb: rel.thumbs,
    display: rel.display,
    video: rel.video,
    duration: Math.round(duration * 10) / 10,
    v: createHash('sha256').update(hash).update(VIDEO_SETTINGS_KEY).digest('hex').slice(0, 10),
  };
  return { record, sha256: hash, rebuilt };
}

async function removeStale(dir: string, keep: Set<string>, ext = '.webp'): Promise<number> {
  let removed = 0;
  for (const f of await readdir(dir)) {
    if (f.endsWith(ext) && !keep.has(f)) {
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
  // Edited videos (FR-24): Google Photos keeps the date and location, so the edit
  // simply replaces its original.
  const videoEdits = new Map<string, string[]>();
  for (const f of all) {
    const m = f.match(/^(.+?)~\d+\.(mp4|mov)$/i);
    if (m) videoEdits.set(m[1], [...(videoEdits.get(m[1]) ?? []), f]);
  }
  if (edits.size === 0 && videoEdits.size === 0) return [];

  // Check everything before changing anything.
  for (const [base, list] of [...edits, ...videoEdits]) {
    if (list.length > 1) {
      throw new Error(
        `${base} has more than one edited copy in originals/ (${list.sort().join(', ')}). ` +
          'Delete all but the one you want, then run again. Nothing was changed.',
      );
    }
  }

  const notes: string[] = [];
  for (const [base, [edit]] of videoEdits) {
    const editPath = path.join(srcDir, edit);
    const target = `${base}${path.extname(edit).toLowerCase()}`;
    const orig = all.find((f) => f !== edit && f.replace(VIDEO_RE, '') === base && VIDEO_RE.test(f));
    if (orig) {
      const t = await exiftool.read(editPath);
      if (t.GPSLatitude == null || !t.CreateDate) {
        throw new Error(
          `${edit} has no date or location, so ${orig} was kept. Delete one of the two, then run again.`,
        );
      }
      await unlink(path.join(srcDir, orig));
    }
    await rename(editPath, path.join(srcDir, target));
    notes.push(orig ? `replaced ${orig} with its edited copy ${edit}, now ${target}` : `renamed ${edit} to ${target}`);
  }
  if (edits.size === 0) return notes;

  const bin = await exiftoolPath();
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

interface Override {
  location?: string | { lat: number; lon: number };
  takenAt?: string;
}
const ISO_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2})(:\d{2})?([+-]\d{2}:\d{2})$/;

/**
 * Applies overrides.json (FR-25) to the photo records. Per photo:
 *   location: the id of another photo whose position (from its own GPS) is copied, or { lat, lon }
 *   takenAt:  the id of another photo whose capture time is copied, or "YYYY-MM-DDTHH:MM[:SS]+HH:MM"
 * Values are copied from the other photo's own metadata, never from another override.
 * Entries for photos that no longer exist are removed from the file. Returns notes.
 */
async function applyOverrides(albumDir: string, photos: PhotoRecord[]): Promise<string[]> {
  const file = path.join(albumDir, 'overrides.json');
  const text = await readFile(file, 'utf8').catch(() => null);
  if (text === null) return [];
  let overrides: Record<string, Override>;
  try {
    overrides = JSON.parse(text);
  } catch (err) {
    throw new Error(`${file} is not valid JSON (${(err as Error).message}). Fix it and run again.`);
  }
  const notes: string[] = [];
  const byId = new Map(photos.map((p) => [p.id, p]));
  const own = new Map(photos.map((p) => [p.id, { lat: p.lat, lon: p.lon, takenAt: p.takenAt }]));
  const problems: string[] = [];
  let locations = 0;
  let dates = 0;
  for (const [id, o] of Object.entries(overrides)) {
    const photo = byId.get(id);
    if (!photo) continue; // removed below
    if (typeof o !== 'object' || o === null || Array.isArray(o)) {
      problems.push(`${id}: expected { "location": …, "takenAt": … }`);
      continue;
    }
    for (const key of Object.keys(o)) {
      if (key !== 'location' && key !== 'takenAt') problems.push(`${id}: unknown field "${key}"`);
    }
    if (o.location !== undefined) {
      const v = o.location;
      let pos: { lat: number; lon: number } | undefined;
      if (typeof v === 'string') {
        const src = own.get(v);
        if (src?.lat != null && src.lon != null) pos = { lat: src.lat, lon: src.lon };
        else problems.push(`${id}: ${src ? `${v} has no GPS of its own` : `no photo ${v}`}`);
      } else if (typeof v?.lat === 'number' && typeof v?.lon === 'number' && Math.abs(v.lat) <= 90 && Math.abs(v.lon) <= 180) {
        pos = { lat: v.lat, lon: v.lon };
      } else {
        problems.push(`${id}: location must be a photo id or { "lat": number, "lon": number }`);
      }
      if (pos) {
        photo.lat = pos.lat;
        photo.lon = pos.lon;
        photo.alt = null;
        photo.locationSetByHand = true;
        locations++;
      }
    }
    if (o.takenAt !== undefined) {
      const v = o.takenAt;
      const m = typeof v === 'string' ? v.match(ISO_RE) : null;
      let t: string | null = null;
      if (m) t = `${m[1]}${m[2] ?? ':00'}${m[3]}`;
      else if (typeof v === 'string' && own.has(v)) {
        t = own.get(v)!.takenAt;
        if (!t) problems.push(`${id}: ${v} has no capture time of its own`);
      } else {
        problems.push(`${id}: takenAt must be a photo id or a time like "2024-06-27T10:45:00+01:00"`);
      }
      if (t) {
        photo.takenAt = t;
        photo.dateSetByHand = true;
        dates++;
      }
    }
  }
  if (problems.length) notes.push(`WARNING: overrides.json entries not applied: ${problems.join('; ')}`);
  if (locations || dates) notes.push(`from overrides.json: set ${locations} location(s) and ${dates} capture time(s)`);

  const orphans = Object.keys(overrides).filter((id) => !byId.has(id));
  if (orphans.length) {
    for (const id of orphans) delete overrides[id];
    await writeFile(file, JSON.stringify(overrides, null, 2) + '\n');
    notes.push(`removed ${orphans.length} entry(ies) for deleted photos from overrides.json`);
  }
  return notes;
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
async function buildEvents(albumDir: string, photos: PhotoRecord[], lookUp: boolean): Promise<string[]> {
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
  const { file, notes, changed } = await updateEvents(existing, visits, album?.localLanguage?.name ?? 'English', {
    lookUp,
    album: path.basename(albumDir),
  });
  if (changed) await writeFile(eventsPath, JSON.stringify(file, null, 2) + '\n');
  return notes;
}

async function buildAlbum(album: string, lookUpEvents: boolean) {
  const started = Date.now();
  const albumDir = path.join(ALBUMS_DIR, album);
  const srcDir = path.join(albumDir, 'originals');
  const outDir = path.join(albumDir, 'generated');
  const notes = await mergeEdits(srcDir);
  const all = (await readdir(srcDir)).sort();
  const files = all.filter((f) => /\.jpe?g$/i.test(f));
  const videos = all.filter((f) => VIDEO_RE.test(f));
  if (files.length + videos.length === 0) throw new Error(`No photos or videos found in ${srcDir}`);
  const clash = videos.map((f) => f.replace(VIDEO_RE, '')).filter((id) => files.some((f) => f.replace(/(\.MP)?\.jpe?g$/i, '') === id));
  if (clash.length) throw new Error(`A photo and a video share the name ${clash.join(', ')}. Rename one, then run again.`);

  for (const dir of [...Object.keys(SIZES), 'videos']) await mkdir(path.join(outDir, dir), { recursive: true });

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
  // One video at a time: ffmpeg already uses every CPU core. Converting takes a while.
  for (const [i, f] of videos.entries()) {
    results.push(await processVideo(srcDir, outDir, f, prevManifest));
    process.stdout.write(`\r${album}: video ${i + 1}/${videos.length} done`);
  }
  process.stdout.write('\n');

  const photos = results.map((r) => r.record);
  notes.push(...(await applyOverrides(albumDir, photos)));

  // Capture-time order; photos with no date (no EXIF) go last.
  photos.sort(
    (a, b) =>
      Number(a.takenAt == null) - Number(b.takenAt == null) ||
      (a.takenAt ?? '').localeCompare(b.takenAt ?? '') ||
      a.id.localeCompare(b.id),
  );

  const keep = new Set(photos.map((p) => `${p.id}.webp`));
  let stale = 0;
  for (const dir of Object.keys(SIZES)) stale += await removeStale(path.join(outDir, dir), keep);
  const keepVideos = new Set(photos.filter((p) => p.video).map((p) => `${p.id}.mp4`));
  stale += await removeStale(path.join(outDir, 'videos'), keepVideos, '.mp4');

  await writeFile(path.join(outDir, 'photos.json'), JSON.stringify({ photos }, null, 2) + '\n');
  const manifest: Manifest = { settings: SETTINGS_KEY, ...(videos.length ? { videoSettings: VIDEO_SETTINGS_KEY } : {}), photos: {} };
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
      `(${files.length} photos${videos.length ? `, ${videos.length} videos` : ''}, ${secs} s)` +
      (stale ? `; deleted ${stale} stale image files` : ''),
  );
  notes.push(...(await tidyAlbumFiles(albumDir, photos)));
  notes.push(...(await buildEvents(albumDir, photos, lookUpEvents)));
  const undated = photos.filter((p) => p.takenAt == null).map((p) => p.id);
  if (undated.length) notes.push(`no capture date, so listed last under "Unknown date": ${undated.join(', ')}`);
  const missing = photos.filter((p) => p.lat == null).map((p) => p.id);
  if (missing.length) notes.push(`no GPS, so not on the map: ${missing.join(', ')}`);
  for (const n of notes) console.log(`  ${n}`);
}

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a.startsWith('-') && a !== '--events');
  if (unknown.length) throw new Error(`Unknown option ${unknown.join(', ')}. The only option is --events.`);
  // Event lookups cost money, so they run only when asked for (FR-23).
  const lookUpEvents = args.includes('--events');
  let albums = args.filter((a) => !a.startsWith('-'));
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
  try {
    for (const album of albums) await buildAlbum(album, lookUpEvents);
  } finally {
    await exiftool.end(); // otherwise its helper process keeps Node running
  }
}

main().catch((err) => {
  console.error(process.env.DEBUG || !(err instanceof Error) ? err : `\nError: ${err.message}`);
  process.exit(1);
});
