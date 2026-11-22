// Loads album data and derives everything the views need.
// Place assignment (FR-2) happens here, so editing places.json takes effect
// on reload without re-running the photo build.

import { type AlbumEvent, type PlaceFile, OTHER_PLACE, distanceM, nearestPlace, visitKey } from './places.ts';

export { type AlbumEvent, type PlaceFile, OTHER_PLACE, distanceM };

export interface PhotoFile {
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
  v?: string; // image version, for cache busting
  locationSetByHand?: true; // position from overrides.json, not the photo's GPS (FR-25)
  dateSetByHand?: true; // capture time from overrides.json (FR-25)
  video?: string; // videos only (FR-24): web copy, relative to generated/; thumb and display are a still frame
  duration?: number; // videos only: length in seconds
}

export interface Photo extends PhotoFile {
  placeId: string;
  caption: string;
  day: string; // YYYY-MM-DD, local to where the photo was taken
  time: string; // HH:MM
  thumbUrl: string;
  displayUrl: string;
  videoUrl?: string;
  index: number; // position in the album, in time order
}

export interface Place extends PlaceFile {
  photos: Photo[];
}

export interface AlbumFile {
  title: string;
  titleLocal?: string;
  summary?: string;
  localLanguage?: { code: string; name: string };
  timeZoneLabel?: string;
  coverPhotoId?: string;
  sortOrder?: number;
}

export interface Album extends AlbumFile {
  id: string;
  photos: Photo[];
  byId: Map<string, Photo>;
  places: Place[]; // in order of first visit
  placeById: Map<string, Place>;
  days: string[];
  cover: Photo | undefined;
  travelKm: number;
  events: Map<string, AlbumEvent[]>; // visitKey(place, day) -> events (FR-23)
}

const BASE = `${import.meta.env.BASE_URL}albums/`;
/** The day of a photo with no capture date (no EXIF). The build lists these last. */
export const UNKNOWN_DAY = 'unknown';
export const isDated = (day: string) => day !== UNKNOWN_DAY;

async function getJson<T>(url: string, fallback?: T): Promise<T> {
  // Always check with the server for a newer copy; an unchanged file costs a 304.
  const res = await fetch(url, { cache: 'no-cache' });
  if (!res.ok) {
    if (fallback !== undefined) return fallback;
    throw new Error(`Could not load ${url} (${res.status})`);
  }
  return res.json() as Promise<T>;
}

export async function loadAlbumIds(): Promise<string[]> {
  return (await getJson<{ albums: string[] }>(`${BASE}index.json`)).albums;
}

const cache = new Map<string, Promise<Album>>();

export function loadAlbum(id: string): Promise<Album> {
  let p = cache.get(id);
  if (!p) {
    p = fetchAlbum(id);
    cache.set(id, p);
    p.catch(() => cache.delete(id));
  }
  return p;
}

async function fetchAlbum(id: string): Promise<Album> {
  const dir = `${BASE}${id}/`;
  const [meta, placeFiles, captions, generated, eventsFile] = await Promise.all([
    getJson<AlbumFile>(`${dir}album.json`),
    getJson<PlaceFile[]>(`${dir}places.json`, []),
    getJson<Record<string, string>>(`${dir}captions.json`, {}),
    getJson<{ photos: PhotoFile[] }>(`${dir}generated/photos.json`),
    getJson<Record<string, { events?: AlbumEvent[] }>>(`${dir}events.json`, {}),
  ]);
  const events = new Map<string, AlbumEvent[]>();
  for (const [key, v] of Object.entries(eventsFile)) if (v.events?.length) events.set(key, v.events);

  const photos: Photo[] = generated.photos.map((p, index) => ({
    ...p,
    placeId: nearestPlace(placeFiles, p),
    caption: captions[p.id] ?? '',
    day: p.takenAt?.slice(0, 10) ?? UNKNOWN_DAY,
    time: p.takenAt?.slice(11, 16) ?? '',
    thumbUrl: `${dir}generated/${p.thumb}${p.v ? `?v=${p.v}` : ''}`,
    displayUrl: `${dir}generated/${p.display}${p.v ? `?v=${p.v}` : ''}`,
    videoUrl: p.video ? `${dir}generated/${p.video}${p.v ? `?v=${p.v}` : ''}` : undefined,
    index,
  }));

  const placeById = new Map<string, Place>();
  for (const pf of placeFiles) placeById.set(pf.id, { ...pf, photos: [] });
  for (const photo of photos) {
    let place = placeById.get(photo.placeId);
    if (!place) {
      place = { id: OTHER_PLACE, name: 'Other', lat: photo.lat ?? 0, lon: photo.lon ?? 0, radiusM: 0, photos: [] };
      placeById.set(OTHER_PLACE, place);
    }
    place.photos.push(photo);
  }
  const places = [...placeById.values()]
    .filter((p) => p.photos.length > 0)
    .sort((a, b) => a.photos[0].index - b.photos[0].index);

  let travelM = 0;
  let prev: Photo | undefined;
  for (const p of photos) {
    if (p.lat == null || p.lon == null) continue;
    if (prev) {
      const d = distanceM(prev.lat!, prev.lon!, p.lat, p.lon);
      if (d > 200) travelM += d; // ignore GPS jitter while walking around one spot
    }
    prev = p;
  }

  const byId = new Map(photos.map((p) => [p.id, p]));
  return {
    ...meta,
    id,
    photos,
    byId,
    places,
    placeById,
    days: [...new Set(photos.map((p) => p.day))],
    cover: (meta.coverPhotoId && byId.get(meta.coverPhotoId)) || photos[0],
    travelKm: Math.round(travelM / 1000),
    events,
  };
}

/** Events at a place on a given day (FR-23). */
export function eventsFor(album: Album, placeId: string, day: string): AlbumEvent[] {
  return album.events.get(visitKey(placeId, day)) ?? [];
}

// ---- formatting ----

/** A list of events for the info panel and place cards (FR-23). */
export function eventListHtml(album: Album, events: AlbumEvent[], heading: string): string {
  if (events.length === 0) return '';
  const lang = album.localLanguage?.code ?? '';
  return `<section class="events">
    <h3 class="events-heading"><span aria-hidden="true">★</span> ${esc(heading)}</h3>
    ${events
      .map(
        (e) => `<div class="event">
          <div class="event-name">${e.sourceUrl ? `<a href="${esc(e.sourceUrl)}" target="_blank" rel="noopener">${esc(e.name)}</a>` : esc(e.name)}</div>
          ${e.nameLocal ? `<div class="local" lang="${esc(lang)}">${esc(e.nameLocal)}</div>` : ''}
          <div class="event-dates">${esc(e.startDate === e.endDate ? dayLabel(e.startDate, true) : `${dayLabel(e.startDate)} – ${dayLabel(e.endDate, true)}`)}</div>
          ${e.description ? `<p class="event-description">${esc(e.description)}</p>` : ''}
        </div>`,
      )
      .join('')}
  </section>`;
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function dayLabel(day: string, withYear = false): string {
  const m = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return 'Unknown date';
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const wd = WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  return `${wd} ${d} ${MONTHS[mo - 1]}${withYear ? ` ${y}` : ''}`;
}

export function dateRange(allDays: string[]): string {
  const days = allDays.filter(isDated); // photos with no date don't widen the range
  if (days.length === 0) return '';
  const first = days[0];
  const last = days[days.length - 1];
  const [y1, m1, d1] = first.split('-').map(Number);
  const [y2, m2, d2] = last.split('-').map(Number);
  if (first === last) return `${d1} ${MONTHS[m1 - 1]} ${y1}`;
  if (y1 === y2 && m1 === m2) return `${d1}–${d2} ${MONTHS[m1 - 1]} ${y1}`;
  if (y1 === y2) return `${d1} ${MONTHS[m1 - 1]} – ${d2} ${MONTHS[m2 - 1]} ${y1}`;
  return `${d1} ${MONTHS[m1 - 1]} ${y1} – ${d2} ${MONTHS[m2 - 1]} ${y2}`;
}

export function timeRange(photos: Photo[]): string {
  const a = photos[0]?.time;
  const b = photos[photos.length - 1]?.time;
  return a === b ? a : `${a}–${b}`;
}

export function photoAlt(album: Album, p: Photo): string {
  const place = album.placeById.get(p.placeId);
  const text =
    p.caption ||
    (isDated(p.day) ? `${place?.name ?? 'Photo'}, ${dayLabel(p.day)} ${p.time}` : `${place?.name ?? 'Photo'}, date unknown`);
  return p.videoUrl ? `Video (${formatDuration(p.duration)}): ${text}` : text;
}

/** 95.2 -> "1:35" */
export function formatDuration(seconds: number | undefined): string {
  const s = Math.round(seconds ?? 0);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export const DAY_COLORS = ['#c0562b', '#2f74b5', '#2e8b57', '#8e4fbf', '#b8860b', '#c2417a'];

export function dayColor(album: Album, day: string): string {
  return DAY_COLORS[Math.max(0, album.days.indexOf(day)) % DAY_COLORS.length];
}

export function esc(s: string | number | null | undefined): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
