# Photo Albums

Trip photo albums with maps and place notes, published at
https://mike-eovino.github.io/photo-albums/. See [SRS.md](SRS.md) for the full specification.

## Everyday tasks

Run commands from the repository root or from `app/` (Node 22.18 or newer).

| Task | Command |
| --- | --- |
| Install once | `npm install` |
| Process new or changed photos and videos | `npm run photos` (or `npm run photos -- chennai-2026`) |
| Look up events for new visits (costs money) | `npm run photos -- chennai-2026 --events` |
| Preview locally | `npm run dev`, then open http://localhost:5173/photo-albums/ |
| Publish | commit and push to `main`; GitHub Actions deploys in about a minute |

Captions, place names and descriptions live in `albums/<id>/captions.json`, `places.json`
and `album.json`. Edit them and push; no photo rebuild is needed.

`npm run photos -- <id> --events` also looks up significant events for each new visit (a place
on a date) with Claude and web search, and saves them to `albums/<id>/events.json`, which you can edit. It reads
the Anthropic API key from the macOS Keychain. To store or replace it, run this in Terminal and
paste the key at the prompt:

    security add-generic-password -U -a "$USER" -s photo-albums-anthropic -w

Without `--events`, the build only reports how many visits are waiting and what the lookup would
cost. Without a key, it skips the lookup. Each new visit costs about 25–30¢. To look a visit up
again, delete its entry from `events.json`.

## Adding an album

1. Create `albums/<id>/originals/` and copy the photos and videos in. They are never committed.
2. Add `album.json`, `places.json` and `captions.json` (copy the Chennai ones as a template).
3. Run `npm run photos -- <id>`, check it with `npm run dev`, then commit and push.

To keep a photo private, delete it from `originals/` and run `npm run photos` again. Places
left with no photos, and captions of deleted photos, are removed from the JSON files.

To use an edited photo, save the edit in Google Photos and put the copy (for example
`PXL_…~2.jpg`) in `originals/` next to the original. `npm run photos` copies the original's
date, location and camera into the edited copy, deletes the original, and renames the copy
to the original's name, so its caption and links keep working.

If a photo has no location or date, or a wrong one, set it in `albums/<id>/overrides.json`,
either by copying it from another photo or by writing it out, then run `npm run photos`:

    {
      "PXL_20240628_163255701": { "location": "PXL_20240628_163301598" },
      "IMG_20251103_165547": {
        "location": { "lat": 56.3431, "lon": -2.8030 },
        "takenAt": "2024-06-27T10:45:00+01:00"
      }
    }

`takenAt` can also be another photo's id, to copy its time.

Videos (`.mp4`, `.mov`) are converted to 1080p web copies with no location or date in them,
about as long as the video plays. An edited video (`…~2.mp4`) replaces its original. GitHub
refuses files over 100 MB, so a web copy over 95 MB stops the build; trim the video first.
