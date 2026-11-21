// Place matching (FR-2), shared by the app and the photo build script.
// No browser or Node APIs here, so both can import it.

export interface PlaceFile {
  id: string;
  name: string;
  nameLocal?: string;
  area?: string;
  lat: number;
  lon: number;
  radiusM: number;
  description?: string;
}

export const OTHER_PLACE = 'other';

/** A significant event at a place during a visit (FR-23), as stored in events.json. */
export interface AlbumEvent {
  name: string;
  nameLocal: string;
  description: string;
  startDate: string;
  endDate: string;
  sourceUrl: string;
  confidence: 'high' | 'medium';
}

/** events.json key for a visit: a place on a local date. */
export const visitKey = (placeId: string, date: string) => `${placeId}@${date}`;

export function distanceM(lat1: number, lon1: number, lat2: number, lon2: number): number {
  const R = 6371000;
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

/** The nearest place whose radius contains the photo, or OTHER_PLACE. */
export function nearestPlace(places: PlaceFile[], p: { lat: number | null; lon: number | null }): string {
  if (p.lat == null || p.lon == null) return OTHER_PLACE;
  let best: { id: string; d: number } | null = null;
  for (const place of places) {
    const d = distanceM(p.lat, p.lon, place.lat, place.lon);
    if (d <= place.radiusM && (!best || d < best.d)) best = { id: place.id, d };
  }
  return best?.id ?? OTHER_PLACE;
}
