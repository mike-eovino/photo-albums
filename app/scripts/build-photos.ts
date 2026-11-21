// For each album, reads the original photos (read only), extracts EXIF metadata,
// and writes EXIF-free WebP copies plus photos.json into the album's generated/
// folder. Place assignment happens in the app, so editing places.json never
// requires re-running this script.
// SRS: FR-1, FR-3, FR-4, FR-17, NFR-2, NFR-8.
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

import { readdir, readFile, writeFile, mkdir, stat, unlink, access } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import path from 'node:path';
import exifr from 'exifr';
import sharp from 'sharp';

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

async function buildAlbum(album: string) {
  const started = Date.now();
  const srcDir = path.join(ALBUMS_DIR, album, 'originals');
  const outDir = path.join(ALBUMS_DIR, album, 'generated');
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
  const missing = photos.filter((p) => p.lat == null).length;
  if (missing) console.warn(`  ${missing} photo(s) have no GPS and will not appear on the map`);
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
  console.error(err);
  process.exit(1);
});
