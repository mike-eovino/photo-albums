# Photo Albums

Trip photo albums with maps and place notes, published at
https://mike-eovino.github.io/photo-albums/. See [SRS.md](SRS.md) for the full specification.

## Everyday tasks

All commands run from `app/` (Node 22.18 or newer).

| Task | Command |
| --- | --- |
| Install once | `npm install` |
| Process new or changed photos | `npm run photos` (or `npm run photos -- chennai-2026`) |
| Preview locally | `npm run dev`, then open http://localhost:5173/photo-albums/ |
| Publish | commit and push to `main`; GitHub Actions deploys in about a minute |

Captions, place names and descriptions live in `albums/<id>/captions.json`, `places.json`
and `album.json`. Edit them and push; no photo rebuild is needed.

## Adding an album

1. Create `albums/<id>/originals/` and copy the photos in. They are never committed.
2. Add `album.json`, `places.json` and `captions.json` (copy the Chennai ones as a template).
3. Run `npm run photos -- <id>`, check it with `npm run dev`, then commit and push.

To keep a photo private, delete it from `originals/` and run `npm run photos` again.
