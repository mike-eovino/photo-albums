import './styles.css';
import {
  type Album,
  type Photo,
  dateRange,
  dayColor,
  dayLabel,
  esc,
  loadAlbum,
  loadAlbumIds,
  photoAlt,
  timeRange,
} from './data.ts';
import { renderMap } from './map.ts';
import { Viewer } from './viewer.ts';

// ---- routing ----
// #/                              album list
// #/<album>?day=&place=           gallery (FR-5, FR-12)
// #/<album>/map?place=            map (FR-8, FR-9)
// #/<album>/places                places (FR-10)
// #/<album>/photo/<id>?from=&day=&place=&play=1   viewer over a view (FR-13)

type View = 'home' | 'gallery' | 'map' | 'places';

interface Route {
  view: View;
  album?: string;
  photo?: string;
  params: URLSearchParams;
}

function parseRoute(): Route {
  const hash = location.hash.replace(/^#\/?/, '').replace(/#[\w-]*$/, ''); // drop in-page anchors like #place-x
  const [path, query = ''] = hash.split('?');
  const params = new URLSearchParams(query);
  const parts = path.split('/').filter(Boolean).map(decodeURIComponent);
  if (parts.length === 0) return { view: 'home', params };
  const [album, sub, id] = parts;
  if (sub === 'photo' && id) {
    const from = params.get('from');
    return { view: from === 'map' || from === 'places' ? from : 'gallery', album, photo: id, params };
  }
  if (sub === 'map' || sub === 'places') return { view: sub, album, params };
  return { view: 'gallery', album, params };
}

function href(album: string, sub = '', params: Record<string, string | undefined> = {}): string {
  const q = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v) q.set(k, v);
  const qs = q.toString();
  return `#/${encodeURIComponent(album)}${sub ? `/${sub}` : ''}${qs ? `?${qs}` : ''}`;
}

const app = document.getElementById('app')!;
const viewer = new Viewer();
let renderedKey = '';
let cleanup: (() => void) | null = null;

function baseKey(r: Route): string {
  const day = r.params.get('day') ?? '';
  const place = r.params.get('place') ?? '';
  return `${r.view}|${r.album ?? ''}|${r.view === 'gallery' ? `${day}|${place}` : r.view === 'map' && !r.photo ? place : ''}`;
}

async function render() {
  const r = parseRoute();
  const key = baseKey(r);
  try {
    if (key !== renderedKey) {
      cleanup?.();
      cleanup = null;
      renderedKey = key;
      if (r.view === 'home') await renderHome();
      else {
        const album = await loadAlbum(r.album!);
        if (renderedKey !== key) return; // a newer navigation won
        renderAlbum(album, r);
      }
    }
    if (r.album && r.photo) {
      const album = await loadAlbum(r.album);
      openViewer(album, r);
    } else viewer.close();
  } catch (err) {
    console.error(err);
    renderedKey = '';
    app.innerHTML = `<main class="page"><h1>Something went wrong</h1><p>${esc((err as Error).message)}</p><p><a href="#/">Back to all albums</a></p></main>`;
  }
}

window.addEventListener('hashchange', render);
render();

// ---- home: album list ----

async function renderHome() {
  document.title = 'Photo Albums';
  app.innerHTML = `<main class="page"><header class="site-header"><h1>Photo Albums</h1></header><p class="muted">Loading…</p></main>`;
  const ids = await loadAlbumIds();
  const albums = (await Promise.all(ids.map((id) => loadAlbum(id)))).sort(
    (a, b) => (a.sortOrder ?? 0) - (b.sortOrder ?? 0) || (b.days[0] ?? '').localeCompare(a.days[0] ?? ''),
  );
  app.innerHTML = `
    <main class="page">
      <header class="site-header"><h1>Photo Albums</h1></header>
      <div class="album-grid">
        ${albums
          .map(
            (a) => `
          <a class="album-card" href="${href(a.id)}">
            ${a.cover ? `<img src="${esc(a.cover.displayUrl)}" alt="${esc(photoAlt(a, a.cover))}" loading="lazy">` : ''}
            <div class="album-card-body">
              <h2>${esc(a.title)}</h2>
              ${a.titleLocal ? `<div class="local" lang="${esc(a.localLanguage?.code)}">${esc(a.titleLocal)}</div>` : ''}
              <div class="muted">${esc(dateRange(a.days))} · ${a.photos.length} photos · ${a.places.length} places</div>
            </div>
          </a>`,
          )
          .join('')}
      </div>
    </main>`;
}

// ---- album shell ----

function renderAlbum(album: Album, r: Route) {
  document.title = album.title;
  const tab = (v: View, label: string, sub: string) =>
    `<a href="${href(album.id, sub)}" class="tab" ${r.view === v ? 'aria-current="page"' : ''}>${label}</a>`;
  app.innerHTML = `
    <header class="album-header">
      <div class="page">
        <a class="crumb" href="#/">← All albums</a>
        <h1>${esc(album.title)}</h1>
        ${album.titleLocal ? `<div class="local title-local" lang="${esc(album.localLanguage?.code)}">${esc(album.titleLocal)}</div>` : ''}
        ${album.summary ? `<p class="summary">${esc(album.summary)}</p>` : ''}
        <ul class="stats">
          <li><strong>${album.photos.length}</strong> photos</li>
          <li><strong>${album.places.length}</strong> places</li>
          <li><strong>${album.days.length}</strong> days</li>
          <li><strong>${album.travelKm}</strong> km between stops</li>
          <li>${esc(dateRange(album.days))}</li>
        </ul>
        <nav class="tabs" aria-label="Album views">
          ${tab('gallery', 'Gallery', '')}${tab('map', 'Map', 'map')}${tab('places', 'Places', 'places')}
        </nav>
      </div>
    </header>
    <main id="view"></main>`;
  const view = document.getElementById('view')!;
  if (r.view === 'map') renderMapView(view, album, r);
  else if (r.view === 'places') renderPlaces(view, album);
  else renderGallery(view, album, r);
}

// ---- gallery ----

function filtered(album: Album, params: URLSearchParams): Photo[] {
  const day = params.get('day');
  const place = params.get('place');
  return album.photos.filter((p) => (!day || p.day === day) && (!place || p.placeId === place));
}

function renderGallery(view: HTMLElement, album: Album, r: Route) {
  const day = r.params.get('day') ?? undefined;
  const place = r.params.get('place') ?? undefined;
  const photos = filtered(album, r.params);

  // consecutive runs of the same day + place
  const groups: Photo[][] = [];
  for (const p of photos) {
    const g = groups.at(-1);
    if (g && g[0].day === p.day && g[0].placeId === p.placeId) g.push(p);
    else groups.push([p]);
  }
  const lang = album.localLanguage?.code ?? '';
  let lastDay = '';

  view.className = 'page';
  view.innerHTML = `
    <div class="filters" role="group" aria-label="Filter photos">
      <div class="chips">
        <a class="chip" href="${href(album.id, '', { place })}" ${!day ? 'aria-current="true"' : ''}>All days</a>
        ${album.days
          .map(
            (d) =>
              `<a class="chip" href="${href(album.id, '', { day: d, place })}" ${day === d ? 'aria-current="true"' : ''}><span class="swatch" style="background:${dayColor(album, d)}"></span>${esc(dayLabel(d))}</a>`,
          )
          .join('')}
      </div>
      <label class="place-filter">Place
        <select id="place-select">
          <option value="">All places</option>
          ${album.places.map((p) => `<option value="${esc(p.id)}" ${place === p.id ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}
        </select>
      </label>
      <button type="button" class="button primary" id="play" ${photos.length === 0 ? 'disabled' : ''}>▶ Slideshow</button>
    </div>
    ${photos.length === 0 ? `<p class="muted">No photos match these filters.</p>` : ''}
    ${groups
      .map((g) => {
        const pl = album.placeById.get(g[0].placeId)!;
        const dayHead = g[0].day !== lastDay ? `<h2 class="day-heading"><span class="swatch" style="background:${dayColor(album, g[0].day)}"></span>${esc(dayLabel(g[0].day, true))}</h2>` : '';
        lastDay = g[0].day;
        return `${dayHead}
        <section class="group">
          <h3 class="group-heading">
            <a href="${href(album.id, 'places')}#place-${esc(pl.id)}">${esc(pl.name)}</a>
            ${pl.nameLocal ? `<span class="local" lang="${esc(lang)}">${esc(pl.nameLocal)}</span>` : ''}
            <span class="muted">${esc(timeRange(g))} · ${g.length} photo${g.length === 1 ? '' : 's'}</span>
          </h3>
          <div class="grid">
            ${g
              .map((p) => {
                const ar = p.width && p.height ? p.width / p.height : 1;
                return `<a class="thumb" href="${href(album.id, `photo/${encodeURIComponent(p.id)}`, { day, place })}" style="flex:${ar} 1 ${Math.round(ar * 190)}px">
                  <img src="${esc(p.thumbUrl)}" alt="${esc(photoAlt(album, p))}" loading="lazy" width="${p.width}" height="${p.height}" style="aspect-ratio:${ar}">
                  ${p.motion ? '<span class="badge small" aria-hidden="true">MP</span>' : ''}
                </a>`;
              })
              .join('')}
          </div>
        </section>`;
      })
      .join('')}`;

  view.querySelector<HTMLSelectElement>('#place-select')!.addEventListener('change', (e) => {
    location.hash = href(album.id, '', { day, place: (e.target as HTMLSelectElement).value || undefined });
  });
  view.querySelector('#play')?.addEventListener('click', () => {
    if (photos[0]) location.hash = href(album.id, `photo/${encodeURIComponent(photos[0].id)}`, { day, place, play: '1' });
  });
}

// ---- map ----

function renderMapView(view: HTMLElement, album: Album, r: Route) {
  view.className = 'map-view';
  view.innerHTML = `<div id="map" role="region" aria-label="Map of places visited"></div>`;
  cleanup = renderMap(view.querySelector('#map')!, album, {
    focusPlace: r.photo ? undefined : (r.params.get('place') ?? undefined),
    onOpenPhoto: (id, place) => {
      location.hash = href(album.id, `photo/${encodeURIComponent(id)}`, { from: 'map', place });
    },
  });
}

// ---- places ----

function renderPlaces(view: HTMLElement, album: Album) {
  const lang = album.localLanguage?.code ?? '';
  view.className = 'page';
  view.innerHTML = `<div class="place-list">
    ${album.places
      .map((pl) => {
        const cover = pl.photos[Math.floor(pl.photos.length / 2)];
        return `<article class="place-card" id="place-${esc(pl.id)}">
          <a class="place-cover" href="${href(album.id, `photo/${encodeURIComponent(cover.id)}`, { from: 'places', place: pl.id })}">
            <img src="${esc(cover.displayUrl)}" alt="${esc(photoAlt(album, cover))}" loading="lazy">
          </a>
          <div class="place-body">
            <h2>${esc(pl.name)}</h2>
            ${pl.nameLocal ? `<div class="local" lang="${esc(lang)}">${esc(pl.nameLocal)}</div>` : ''}
            <div class="muted">${pl.area && pl.area !== pl.name ? `${esc(pl.area)} · ` : ''}${esc(dayLabel(pl.photos[0].day))}, ${esc(timeRange(pl.photos))} · ${pl.photos.length} photo${pl.photos.length === 1 ? '' : 's'}</div>
            ${pl.description ? `<p>${esc(pl.description)}</p>` : ''}
            <div class="actions">
              <a class="button" href="${href(album.id, '', { place: pl.id })}">View photos</a>
              <a class="button" href="${href(album.id, 'map', { place: pl.id })}">Show on map</a>
            </div>
          </div>
        </article>`;
      })
      .join('')}
  </div>`;
  const target = location.hash.match(/#place-[\w-]+$/);
  if (target) document.getElementById(target[0].slice(1))?.scrollIntoView();
}

// ---- viewer ----

function openViewer(album: Album, r: Route) {
  const from = r.params.get('from') ?? undefined;
  let list = filtered(album, r.params);
  if (!list.some((p) => p.id === r.photo)) list = album.photos;
  if (!album.byId.has(r.photo!)) {
    history.replaceState(null, '', href(album.id));
    return render();
  }
  const keep = { from, day: r.params.get('day') ?? undefined, place: r.params.get('place') ?? undefined };
  viewer.open({
    album,
    list,
    photoId: r.photo!,
    autoplay: r.params.get('play') === '1' && !viewer.isOpen,
    onNavigate: (p) => history.replaceState(null, '', href(album.id, `photo/${encodeURIComponent(p.id)}`, keep)),
    onClose: () => {
      const sub = from === 'map' ? 'map' : from === 'places' ? 'places' : '';
      location.hash = href(album.id, sub, from ? {} : { day: keep.day, place: keep.place });
    },
  });
}
