import { defineConfig, type Plugin } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

const ALBUMS_DIR = path.resolve(import.meta.dirname, '..', 'albums');

// Album files the site may serve. originals/ is deliberately absent.
const PUBLIC_FILES = ['album.json', 'places.json', 'captions.json'];
const PUBLIC_DIR = 'generated';
// Build-only files inside generated/ that the site doesn't need.
const PRIVATE_GENERATED = ['build-manifest.json'];

function albumIds(): string[] {
  return fs
    .readdirSync(ALBUMS_DIR, { withFileTypes: true })
    .filter((e) => e.isDirectory() && fs.existsSync(path.join(ALBUMS_DIR, e.name, 'album.json')))
    .map((e) => e.name)
    .sort();
}

function albumIndex(): string {
  return JSON.stringify({ albums: albumIds() });
}

const MIME: Record<string, string> = { '.json': 'application/json', '.webp': 'image/webp' };

// Serves albums/<id>/{album,places,captions}.json and albums/<id>/generated/** in dev,
// and copies only those files into dist/albums/ on build.
function albumsPlugin(): Plugin {
  let base = '/';
  let outDir = 'dist';
  return {
    name: 'photo-albums',
    configResolved(config) {
      base = config.base;
      outDir = path.resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = decodeURIComponent((req.url ?? '').split('?')[0]);
        const prefix = `${base}albums/`;
        if (!url.startsWith(prefix)) return next();
        const rel = url.slice(prefix.length);
        if (rel === 'index.json') {
          res.setHeader('Content-Type', 'application/json');
          return res.end(albumIndex());
        }
        const [album, first, ...rest] = rel.split('/');
        const allowed =
          /^[\w-]+$/.test(album ?? '') &&
          ((rest.length === 0 && PUBLIC_FILES.includes(first ?? '')) ||
            (first === PUBLIC_DIR && rest.length > 0 && !PRIVATE_GENERATED.includes(rest.join('/'))));
        const file = path.resolve(ALBUMS_DIR, rel);
        if (!allowed || !file.startsWith(ALBUMS_DIR + path.sep) || !fs.existsSync(file)) return next();
        res.setHeader('Content-Type', MIME[path.extname(file)] ?? 'application/octet-stream');
        fs.createReadStream(file).pipe(res);
      });
    },
    writeBundle() {
      const dest = path.join(outDir, 'albums');
      fs.mkdirSync(dest, { recursive: true });
      fs.writeFileSync(path.join(dest, 'index.json'), albumIndex());
      for (const id of albumIds()) {
        const src = path.join(ALBUMS_DIR, id);
        fs.mkdirSync(path.join(dest, id), { recursive: true });
        for (const f of PUBLIC_FILES) {
          if (fs.existsSync(path.join(src, f))) fs.copyFileSync(path.join(src, f), path.join(dest, id, f));
        }
        if (fs.existsSync(path.join(src, PUBLIC_DIR))) {
          const genDir = path.join(src, PUBLIC_DIR);
          fs.cpSync(genDir, path.join(dest, id, PUBLIC_DIR), {
            recursive: true,
            filter: (f) => !PRIVATE_GENERATED.includes(path.relative(genDir, f)),
          });
        }
      }
    },
  };
}

export default defineConfig({
  base: '/photo-albums/',
  publicDir: false,
  plugins: [albumsPlugin()],
});
