// Significant events (FR-1, FR-23): for each visit (a place on a given local date),
// ask Claude, with web search, whether anything notable was happening there at the
// time. Results are saved to the album's events.json, which the owner can edit.
// A visit that already has an entry is never looked up again, so re-runs cost
// nothing and owner edits are never overwritten.
//
// The API key is read from the macOS Keychain (service "photo-albums-anthropic"),
// or from PHOTO_ALBUMS_ANTHROPIC_KEY. Without a key, the lookup is skipped.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import Anthropic from '@anthropic-ai/sdk';
import { type AlbumEvent, type PlaceFile, distanceM, nearestPlace, OTHER_PLACE, visitKey } from '../src/places.ts';

const MODEL = 'claude-opus-5-5';
const MAX_SEARCHES_PER_VISIT = 5;
// An event's venue must be within the place's radius of the photos, but never
// less than this. Phone GPS is accurate to about 5-20 m outdoors.
const MIN_EVENT_RADIUS_M = 300;
const KEYCHAIN_SERVICE = 'photo-albums-anthropic';
// List prices used only to print an estimate (USD): Opus 5.5 input / output per
// token, cache reads, and web search per search.
const PRICE = { input: 4e-6, output: 20e-6, cacheRead: 0.2e-6, cacheWrite: 5e-6, search: 0.01 };

export interface VisitEvents {
  place: string;
  date: string;
  checked: string; // date the lookup ran; the owner may edit anything here
  events: AlbumEvent[];
}

export type EventsFile = Record<string, VisitEvents>; // key: "<placeId>@<YYYY-MM-DD>"

interface PhotoLike {
  lat: number | null;
  lon: number | null;
  takenAt: string | null;
}

export interface Visit {
  key: string;
  place: PlaceFile;
  date: string;
  firstTime: string;
  lastTime: string;
  offset: string;
  lat: number; // average of the visit's photo locations
  lon: number;
  spreadM: number; // farthest photo from that average
  coords: [number, number][];
}

/** One visit per place per local date, in time order. Photos in "Other" are skipped. */
export function findVisits(places: PlaceFile[], photos: PhotoLike[]): Visit[] {
  const visits = new Map<string, Visit>();
  for (const p of photos) {
    if (!p.takenAt) continue;
    const placeId = nearestPlace(places, p);
    if (placeId === OTHER_PLACE) continue;
    const date = p.takenAt.slice(0, 10);
    const coord: [number, number] = [p.lat!, p.lon!];
    const time = p.takenAt.slice(11, 16);
    const key = visitKey(placeId, date);
    const v = visits.get(key);
    if (v) {
      if (time < v.firstTime) v.firstTime = time;
      if (time > v.lastTime) v.lastTime = time;
      v.coords.push(coord);
    } else {
      visits.set(key, {
        key,
        place: places.find((pl) => pl.id === placeId)!,
        date,
        firstTime: time,
        lastTime: time,
        offset: p.takenAt.slice(19) || '',
        lat: 0,
        lon: 0,
        spreadM: 0,
        coords: [coord],
      });
    }
  }
  for (const v of visits.values()) {
    v.lat = v.coords.reduce((s, c) => s + c[0], 0) / v.coords.length;
    v.lon = v.coords.reduce((s, c) => s + c[1], 0) / v.coords.length;
    v.spreadM = Math.round(Math.max(...v.coords.map((c) => distanceM(v.lat, v.lon, c[0], c[1]))));
  }
  return [...visits.values()];
}

async function apiKey(): Promise<string | null> {
  if (process.env.PHOTO_ALBUMS_ANTHROPIC_KEY) return process.env.PHOTO_ALBUMS_ANTHROPIC_KEY;
  try {
    const { stdout } = await promisify(execFile)('security', ['find-generic-password', '-s', KEYCHAIN_SERVICE, '-w']);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

const RECORD_TOOL: Anthropic.Beta.BetaTool = {
  name: 'record_events',
  description:
    'Record the result of the research. Call this exactly once, at the end, with every significant event ' +
    'found (or an empty list if there were none).',
  strict: true,
  input_schema: {
    type: 'object',
    additionalProperties: false,
    required: ['events', 'note'],
    properties: {
      events: {
        type: 'array',
        items: {
          type: 'object',
          additionalProperties: false,
          required: ['name', 'nameLocal', 'venue', 'description', 'startDate', 'endDate', 'sourceUrl', 'confidence'],
          properties: {
            name: { type: 'string', description: 'Short English name of the event.' },
            nameLocal: { type: 'string', description: 'Name in the local language and script, or "" if unknown.' },
            venue: {
              type: 'string',
              description: 'Where the event took place, specific enough to check its distance from the photos (for example a street or building).',
            },
            description: {
              type: 'string',
              description: 'One or two plain, factual sentences for a travel album: what it is and why it matters.',
            },
            startDate: { type: 'string', format: 'date' },
            endDate: { type: 'string', format: 'date' },
            sourceUrl: { type: 'string', format: 'uri', description: 'The page that best confirms the event and its date.' },
            confidence: { type: 'string', enum: ['high', 'medium'] },
          },
        },
      },
      note: { type: 'string', description: 'One sentence summarising what was found or why nothing was.' },
    },
  },
};

const SYSTEM = `You research a personal travel photo album. Given a place and the local date and time when photos were taken there, find whether anything significant was happening at that place at that time.

Count as significant: religious festivals, ceremonies, processions or special services at that place; public holidays observed there; public events at the place itself (concerts, exhibitions, sports); and weather or other news that affected the place that day.

Rules:
- The event must include the given date. A multi-day festival counts if the date falls inside it.
- Location is strict. The photo coordinates come from phone GPS and are accurate to within about 20 m. The event's venue must be within the stated distance of where the photos were taken. Something elsewhere in the same neighbourhood, district or city does not count, however famous or close it seems. If you cannot place the venue within that distance, leave the event out.
- It must be something a person standing where the photos were taken, at that time, could have seen, heard or taken part in. Conferences, campus events, private functions and ticketed events at a different venue do not count.
- Record the venue for each event so its location can be checked.
- Report each occasion once. If the date is the main day of a longer festival, report that main day as one event and mention the wider festival in its description.
- Search the web to confirm each event and its dates. Include only events you can support with a source; use "medium" confidence when the source is indirect.
- Ordinary daily rituals, normal opening hours, and routine tourism are not events.
- An empty list is a good answer when nothing notable was happening.
- Finish by calling record_events exactly once.`;

function userPrompt(v: Visit, localLanguage: string): string {
  const pl = v.place;
  const times = v.firstTime === v.lastTime ? v.firstTime : `${v.firstTime}–${v.lastTime}`;
  return [
    `Place: ${pl.name}${pl.nameLocal ? ` (${pl.nameLocal})` : ''}`,
    pl.area ? `Area: ${pl.area}` : '',
    `Where the photos were taken: ${v.lat.toFixed(5)}, ${v.lon.toFixed(5)}` +
      (v.spreadM > 30 ? ` (the photos are spread over about ${v.spreadM} m)` : ''),
    `Events must be within ${Math.max(pl.radiusM, MIN_EVENT_RADIUS_M) + v.spreadM} m of that point.`,
    pl.description ? `About the place: ${pl.description}` : '',
    `Local date: ${v.date}`,
    `Local time of the photos: ${times}${v.offset ? ` (UTC${v.offset})` : ''}`,
    `Local language for nameLocal: ${localLanguage}`,
  ]
    .filter(Boolean)
    .join('\n');
}

interface LookupResult {
  events: AlbumEvent[];
  searches: number;
  cost: number;
}

async function lookUp(client: Anthropic, v: Visit, localLanguage: string): Promise<LookupResult> {
  const messages: Anthropic.Beta.BetaMessageParam[] = [{ role: 'user', content: userPrompt(v, localLanguage) }];
  let searches = 0;
  let cost = 0;
  // A paused server-tool turn is resumed by sending it back; cap the rounds.
  for (let round = 0; round < 4; round++) {
    const response = await client.beta.messages.create({
      model: MODEL,
      max_tokens: 16000,
      system: SYSTEM,
      output_config: { effort: 'medium' },
      tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: MAX_SEARCHES_PER_VISIT }, RECORD_TOOL],
      tool_choice: { type: 'auto' },
      // If a safety classifier declines, the API retries on a suitable model.
      betas: ['server-side-fallback-2026-07-01'],
      fallbacks: 'default',
      messages,
    });
    const u = response.usage;
    const s = u.server_tool_use?.web_search_requests ?? 0;
    searches += s;
    cost +=
      u.input_tokens * PRICE.input +
      u.output_tokens * PRICE.output +
      (u.cache_read_input_tokens ?? 0) * PRICE.cacheRead +
      (u.cache_creation_input_tokens ?? 0) * PRICE.cacheWrite +
      s * PRICE.search;

    const call = response.content.find(
      (b): b is Anthropic.Beta.BetaToolUseBlock => b.type === 'tool_use' && b.name === 'record_events',
    );
    if (call) {
      const input = call.input as { events: AlbumEvent[] };
      return { events: input.events, searches, cost };
    }
    if (response.stop_reason === 'pause_turn') {
      messages.push({ role: 'assistant', content: response.content });
      continue;
    }
    if (response.stop_reason === 'refusal') throw new Error('the request was declined');
    throw new Error(`no result recorded (stop reason: ${response.stop_reason})`);
  }
  throw new Error('the search did not finish');
}

/**
 * Looks up events for visits that have no entry in `existing`, and drops entries
 * for visits that no longer exist. Returns the new file contents and log notes.
 */
export async function updateEvents(
  existing: EventsFile,
  visits: Visit[],
  localLanguage: string,
): Promise<{ file: EventsFile; notes: string[]; changed: boolean }> {
  const notes: string[] = [];
  const file: EventsFile = {};
  const keys = new Set(visits.map((v) => v.key));
  const dropped = Object.keys(existing).filter((k) => !keys.has(k));
  for (const k of Object.keys(existing)) if (keys.has(k)) file[k] = existing[k];
  if (dropped.length) notes.push(`removed events for visits that no longer exist: ${dropped.join(', ')}`);

  const todo = visits.filter((v) => !file[v.key]);
  let changed = dropped.length > 0;
  if (todo.length) {
    const key = await apiKey();
    if (!key) {
      notes.push(
        `skipped the event lookup for ${todo.length} visit(s): no API key in the Keychain (service "${KEYCHAIN_SERVICE}")`,
      );
    } else {
      const client = new Anthropic({ apiKey: key, maxRetries: 2 });
      let total = 0;
      let searches = 0;
      const today = new Date().toISOString().slice(0, 10);
      for (const v of todo) {
        process.stdout.write(`  looking up events: ${v.place.name}, ${v.date} … `);
        try {
          const r = await lookUp(client, v, localLanguage);
          file[v.key] = { place: v.place.name, date: v.date, checked: today, events: r.events };
          changed = true;
          total += r.cost;
          searches += r.searches;
          console.log(r.events.length ? r.events.map((e) => e.name).join('; ') : 'nothing notable');
        } catch (err) {
          console.log('failed');
          const msg =
            err instanceof Anthropic.AuthenticationError
              ? 'the API key was rejected'
              : err instanceof Anthropic.PermissionDeniedError || err instanceof Anthropic.BadRequestError
                ? (err as Error).message
                : err instanceof Error
                  ? err.message
                  : String(err);
          notes.push(`event lookup failed for ${v.place.name}, ${v.date}: ${msg}. It will be retried next run.`);
          // Stop on errors that will repeat for every visit (bad key, no credit).
          if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.BadRequestError ||
              err instanceof Anthropic.PermissionDeniedError) break;
        }
      }
      if (searches || total) {
        notes.push(`event lookup: ${searches} web searches, about $${total.toFixed(2)} at list prices`);
      }
    }
  }

  // Keep the file in a stable order: by date, then place.
  const sorted: EventsFile = {};
  for (const k of Object.keys(file).sort((a, b) => file[a].date.localeCompare(file[b].date) || a.localeCompare(b))) {
    sorted[k] = file[k];
  }
  return { file: sorted, notes, changed };
}
