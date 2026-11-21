import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { type Album, type Place, dayColor, dayLabel, esc, timeRange, isDated } from './data.ts';

const TILES = 'https://tile.openstreetmap.org/{z}/{x}/{y}.png';
const ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

function tiles(): L.TileLayer {
  return L.tileLayer(TILES, { maxZoom: 19, attribution: ATTRIBUTION });
}

function markerRadius(count: number): number {
  return 7 + Math.sqrt(count) * 2.6;
}

// FR-8, FR-9: one marker per place sized by photo count, route line colored by day.
export function renderMap(
  el: HTMLElement,
  album: Album,
  opts: { focusPlace?: string; onOpenPhoto: (photoId: string, placeId: string) => void },
): () => void {
  const map = L.map(el, { scrollWheelZoom: true });
  tiles().addTo(map);

  const located = album.photos.filter((p) => p.lat != null && p.lon != null);
  for (const day of album.days) {
    const pts = located.filter((p) => p.day === day).map((p) => [p.lat!, p.lon!] as L.LatLngTuple);
    if (pts.length > 1) {
      L.polyline(pts, { color: dayColor(album, day), weight: 3, opacity: 0.8 }).addTo(map);
    }
  }
  // dashed connectors between days, so the whole trip reads as one path
  for (let i = 1; i < album.days.length; i++) {
    const a = located.filter((p) => p.day === album.days[i - 1]).at(-1);
    const b = located.find((p) => p.day === album.days[i]);
    if (a && b) {
      L.polyline(
        [
          [a.lat!, a.lon!],
          [b.lat!, b.lon!],
        ],
        { color: '#888', weight: 2, opacity: 0.6, dashArray: '4 6' },
      ).addTo(map);
    }
  }

  const markers = new Map<string, L.CircleMarker>();
  for (const place of album.places) {
    if (place.id === 'other') continue;
    const color = dayColor(album, place.photos[0].day);
    const m = L.circleMarker([place.lat, place.lon], {
      radius: markerRadius(place.photos.length),
      color: '#fff',
      weight: 2,
      fillColor: color,
      fillOpacity: 0.9,
    })
      .addTo(map)
      .bindTooltip(`${esc(place.name)} · ${place.photos.length}`, { direction: 'top', offset: [0, -6] })
      .bindPopup(() => popupContent(album, place, opts.onOpenPhoto), { maxWidth: 320, minWidth: 260 });
    markers.set(place.id, m);
  }

  const legend = new L.Control({ position: 'bottomleft' });
  legend.onAdd = () => {
    const div = L.DomUtil.create('div', 'map-legend');
    // Only days that appear on the map (photos with no location or date are left out).
    div.innerHTML = album.days
      .filter((d) => isDated(d) && located.some((p) => p.day === d))
      .map((d) => `<div><span class="swatch" style="background:${dayColor(album, d)}"></span>${esc(dayLabel(d))}</div>`)
      .join('');
    return div;
  };
  legend.addTo(map);

  const focus = opts.focusPlace ? album.placeById.get(opts.focusPlace) : undefined;
  if (focus) {
    map.setView([focus.lat, focus.lon], 16);
    markers.get(focus.id)?.openPopup();
  } else {
    map.fitBounds(L.latLngBounds(album.places.map((p) => [p.lat, p.lon] as L.LatLngTuple)), { padding: [30, 30] });
  }

  return () => map.remove();
}

function popupContent(album: Album, place: Place, onOpen: (photoId: string, placeId: string) => void): HTMLElement {
  const div = document.createElement('div');
  div.className = 'map-popup';
  const shown = place.photos.slice(0, 12);
  const more = place.photos.length - shown.length;
  div.innerHTML = `
    <div class="map-popup-title">${esc(place.name)}</div>
    ${place.nameLocal ? `<div class="local" lang="${esc(album.localLanguage?.code)}">${esc(place.nameLocal)}</div>` : ''}
    <div class="muted">${esc(dayLabel(place.photos[0].day))} · ${esc(timeRange(place.photos))} · ${place.photos.length} photo${place.photos.length === 1 ? '' : 's'}</div>
    <div class="map-popup-thumbs">
      ${shown.map((p) => `<button type="button" data-photo="${esc(p.id)}" aria-label="Open photo: ${esc(p.caption || p.time)}"><img src="${esc(p.thumbUrl)}" alt="" loading="lazy"></button>`).join('')}
    </div>
    ${more > 0 ? `<div class="muted">+${more} more. Click any photo to browse them all.</div>` : ''}`;
  div.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-photo]');
    if (btn) onOpen(btn.dataset.photo!, place.id);
  });
  return div;
}

// Small locator map for the photo info panel (FR-7). One instance, re-centred per photo.
export class MiniMap {
  private map: L.Map | null = null;
  private marker: L.CircleMarker | null = null;

  show(el: HTMLElement, lat: number, lon: number) {
    if (!this.map || this.map.getContainer() !== el) {
      this.destroy();
      this.map = L.map(el, { zoomControl: false, attributionControl: true, scrollWheelZoom: false, dragging: true });
      tiles().addTo(this.map);
      this.marker = L.circleMarker([lat, lon], { radius: 7, color: '#fff', weight: 2, fillColor: '#c0562b', fillOpacity: 1 }).addTo(this.map);
      this.map.setView([lat, lon], 14);
    } else {
      this.marker!.setLatLng([lat, lon]);
      this.map.setView([lat, lon], this.map.getZoom(), { animate: false });
    }
    requestAnimationFrame(() => this.map?.invalidateSize());
  }

  destroy() {
    this.map?.remove();
    this.map = null;
    this.marker = null;
  }
}
