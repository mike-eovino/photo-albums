# Photo Albums

Trip photo albums with maps and place notes, published at
https://mike-eovino.github.io/photo-albums/. See [SRS.md](SRS.md) for the full specification.

## Everyday tasks

Run commands from the repository root or from `app/` (Node 22.18 or newer).

| Task | Command |
| --- | --- |
| Install once | `npm install` |
| Process new or changed photos | `npm run photos` (or `npm run photos -- chennai-2026`) |
| Preview locally | `npm run dev`, then open http://localhost:5173/photo-albums/ |
| Publish | commit and push to `main`; GitHub Actions deploys in about a minute |

Captions, place names and descriptions live in `albums/<id>/captions.json`, `places.json`
and `album.json`. Edit them and push; no photo rebuild is needed.

`npm run photos` also looks up significant events for each new visit (a place on a date) with
Claude and web search, and saves them to `albums/<id>/events.json`, which you can edit. It reads
the Anthropic API key from the macOS Keychain. To store or replace it, run this in Terminal and
paste the key at the prompt:

    security add-generic-password -U -a "$USER" -s photo-albums-anthropic -w

Without a key, the build skips the lookup. Each new visit costs about 25–30¢. To look a visit up
again, delete its entry from `events.json`.

## Adding an album

1. Create `albums/<id>/originals/` and copy the photos in. They are never committed.
2. Add `album.json`, `places.json` and `captions.json` (copy the Chennai ones as a template).
3. Run `npm run photos -- <id>`, check it with `npm run dev`, then commit and push.

To keep a photo private, delete it from `originals/` and run `npm run photos` again. Places
left with no photos, and captions of deleted photos, are removed from the JSON files.

To use an edited photo, save the edit in Google Photos and put the copy (for example
`PXL_…~2.jpg`) in `originals/` next to the original. `npm run photos` copies the original's
date, location and camera into the edited copy, deletes the original, and renames the copy
to the original's name, so its caption and links keep working.
