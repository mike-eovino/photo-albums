// Loads album data and derives everything the views need.
// Place assignment (FR-2) happens here, so editing places.json takes effect
// on reload without re-running the photo build.

import { type PlaceFile, OTHER_PLACE, distanceM, nearestPlace } from './places.ts';

export { type PlaceFile, OTHER_PLACE, distanceM };

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
}

export interface Photo extends PhotoFile {
  placeId: string;
  caption: string;
  day: string; // YYYY-MM-DD, local to where the photo was taken
  time: string; // HH:MM
  thumbUrl: string;
  displayUrl: string;
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
}

const BASE = `${import.meta.env.BASE_URL}albums/`;

async function getJson<T>(url: string, fallback?: T): Promise<T> {
  const res = await fetch(url);
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
  const [meta, placeFiles, captions, generated] = await Promise.all([
    getJson<AlbumFile>(`${dir}album.json`),
    getJson<PlaceFile[]>(`${dir}places.json`, []),
    getJson<Record<string, string>>(`${dir}captions.json`, {}),
    getJson<{ photos: PhotoFile[] }>(`${dir}generated/photos.json`),
  ]);

  const photos: Photo[] = generated.photos.map((p, index) => ({
    ...p,
    placeId: nearestPlace(placeFiles, p),
    caption: captions[p.id] ?? '',
    day: p.takenAt?.slice(0, 10) ?? 'unknown',
    time: p.takenAt?.slice(11, 16) ?? '',
    thumbUrl: `${dir}generated/${p.thumb}`,
    displayUrl: `${dir}generated/${p.display}`,
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
  };
}

// ---- formatting ----

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function dayLabel(day: string, withYear = false): string {
  const m = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return 'Unknown date';
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const wd = WEEKDAYS[new Date(Date.UTC(y, mo - 1, d)).getUTCDay()];
  return `${wd} ${d} ${MONTHS[mo - 1]}${withYear ? ` ${y}` : ''}`;
}

export function dateRange(days: string[]): string {
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
  return p.caption || `${place?.name ?? 'Photo'}, ${dayLabel(p.day)} ${p.time}`;
}

export const DAY_COLORS = ['#c0562b', '#2f74b5', '#2e8b57', '#8e4fbf', '#b8860b', '#c2417a'];

export function dayColor(album: Album, day: string): string {
  return DAY_COLORS[Math.max(0, album.days.indexOf(day)) % DAY_COLORS.length];
}

export function esc(s: string | number | null | undefined): string {
  return String(s ?? '').replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}
