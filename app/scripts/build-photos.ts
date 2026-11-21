// For each album, reads the original photos (read only), extracts EXIF metadata,
// and writes EXIF-free WebP copies plus photos.json into the album's generated/
// folder. Place assignment happens in the app, so editing places.json never
// requires re-running this script.
// SRS: FR-1, FR-3, FR-4, FR-17, NFR-8.
//
// Usage: npm run photos                 (every album that has an originals/ folder)
//        npm run photos -- chennai-2026  (one album)

import { readdir, writeFile, mkdir, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import exifr from 'exifr';
import sharp from 'sharp';

const ALBUMS_DIR = path.resolve(import.meta.dirname, '..', '..', 'albums');
const SIZES = { thumbs: 400, display: 1600 } as const;
const WEBP_QUALITY = 80;
const CONCURRENCY = 4;

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

async function isFresh(src: string, out: string): Promise<boolean> {
  try {
    return (await stat(out)).mtimeMs >= (await stat(src)).mtimeMs;
  } catch {
    return false;
  }
}

async function processPhoto(srcDir: string, outDir: string, file: string): Promise<PhotoRecord> {
  const src = path.join(srcDir, file);
  const id = file.replace(/(\.MP)?\.jpe?g$/i, '');

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

  const rel: Record<keyof typeof SIZES, string> = { thumbs: '', display: '' };
  for (const [dir, size] of Object.entries(SIZES) as [keyof typeof SIZES, number][]) {
    rel[dir] = `${dir}/${id}.webp`;
    const out = path.join(outDir, rel[dir]);
    if (await isFresh(src, out)) continue;
    // sharp writes no EXIF/GPS/XMP unless .withMetadata() is called (FR-4).
    await sharp(src)
      .rotate()
      .resize({ width: size, height: size, fit: 'inside', withoutEnlargement: true })
      .webp({ quality: WEBP_QUALITY })
      .toFile(out);
  }

  const alt = Number(tags?.GPSAltitude);
  return {
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

  const photos: PhotoRecord[] = [];
  for (let i = 0; i < files.length; i += CONCURRENCY) {
    const batch = files.slice(i, i + CONCURRENCY);
    photos.push(...(await Promise.all(batch.map((f) => processPhoto(srcDir, outDir, f)))));
    process.stdout.write(`\r${album}: ${Math.min(i + CONCURRENCY, files.length)}/${files.length}`);
  }
  process.stdout.write('\n');

  photos.sort((a, b) => (a.takenAt ?? '').localeCompare(b.takenAt ?? '') || a.id.localeCompare(b.id));

  const keep = new Set(photos.map((p) => `${p.id}.webp`));
  let stale = 0;
  for (const dir of Object.keys(SIZES)) stale += await removeStale(path.join(outDir, dir), keep);

  await writeFile(path.join(outDir, 'photos.json'), JSON.stringify({ photos }, null, 2) + '\n');

  console.log(`${album}: wrote ${photos.length} photos in ${((Date.now() - started) / 1000).toFixed(1)} s` + (stale ? `, removed ${stale} stale images` : ''));
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
