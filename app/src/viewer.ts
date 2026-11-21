// Full-screen photo viewer with info panel and slideshow (FR-6, FR-7, FR-15, FR-18).
import { type Album, type Photo, dayLabel, esc, eventListHtml, eventsFor, isDated, photoAlt } from './data.ts';
import { MiniMap } from './map.ts';

const SLIDE_MS = 4000;

export interface ViewerOptions {
  album: Album;
  list: Photo[];
  photoId: string;
  autoplay?: boolean;
  onNavigate: (photo: Photo) => void; // keep the URL in sync
  onClose: () => void;
}

export class Viewer {
  private root: HTMLElement;
  private opts!: ViewerOptions;
  private pos = 0;
  private timer: number | undefined;
  private playing = false;
  private infoOpen = true;
  private miniMap = new MiniMap();
  private returnFocus: Element | null = null;
  private touchX: number | null = null;

  constructor() {
    this.root = document.createElement('div');
    this.root.className = 'viewer';
    this.root.setAttribute('role', 'dialog');
    this.root.setAttribute('aria-modal', 'true');
    this.root.setAttribute('aria-label', 'Photo viewer');
    this.root.hidden = true;
    this.root.innerHTML = `
      <div class="viewer-stage">
        <img class="viewer-img" alt="">
        <button type="button" class="viewer-nav prev" aria-label="Previous photo">‹</button>
        <button type="button" class="viewer-nav next" aria-label="Next photo">›</button>
        <div class="viewer-bar">
          <span class="viewer-count" aria-live="polite"></span>
          <span class="spacer"></span>
          <button type="button" class="viewer-btn play" aria-pressed="false">▶ Slideshow</button>
          <button type="button" class="viewer-btn info" aria-pressed="true">Info</button>
          <button type="button" class="viewer-btn close" aria-label="Close viewer">✕</button>
        </div>
        <div class="viewer-progress"><span></span></div>
      </div>
      <aside class="viewer-info" aria-label="Photo details"></aside>`;
    document.body.appendChild(this.root);

    this.q('.prev').addEventListener('click', () => this.step(-1, true));
    this.q('.next').addEventListener('click', () => this.step(1, true));
    this.q('.close').addEventListener('click', () => this.opts.onClose());
    this.q('.play').addEventListener('click', () => this.setPlaying(!this.playing));
    this.q('.info').addEventListener('click', () => {
      this.infoOpen = !this.infoOpen;
      this.root.classList.toggle('info-hidden', !this.infoOpen);
      this.q('.info').setAttribute('aria-pressed', String(this.infoOpen));
      if (this.infoOpen) this.renderInfo();
    });

    const stage = this.q('.viewer-stage');
    stage.addEventListener('touchstart', (e) => (this.touchX = e.touches[0].clientX), { passive: true });
    stage.addEventListener('touchend', (e) => {
      if (this.touchX == null) return;
      const dx = e.changedTouches[0].clientX - this.touchX;
      this.touchX = null;
      if (Math.abs(dx) > 50) this.step(dx < 0 ? 1 : -1, true);
    });

    document.addEventListener('keydown', (e) => {
      if (this.root.hidden) return;
      if (e.key === 'ArrowRight') this.step(1, true);
      else if (e.key === 'ArrowLeft') this.step(-1, true);
      else if (e.key === 'Escape') this.opts.onClose();
      else if (e.key === ' ' && !(e.target instanceof HTMLButtonElement)) {
        e.preventDefault();
        this.setPlaying(!this.playing);
      } else if (e.key === 'Tab') this.trapFocus(e);
      else return;
    });
  }

  get isOpen() {
    return !this.root.hidden;
  }

  open(opts: ViewerOptions) {
    const wasOpen = this.isOpen;
    this.opts = opts;
    this.pos = Math.max(0, opts.list.findIndex((p) => p.id === opts.photoId));
    if (!wasOpen) {
      this.returnFocus = document.activeElement;
      this.root.hidden = false;
      document.body.classList.add('no-scroll');
      this.q<HTMLButtonElement>('.close').focus();
    }
    this.show();
    if (opts.autoplay) this.setPlaying(true);
  }

  close() {
    if (!this.isOpen) return;
    this.setPlaying(false);
    this.root.hidden = true;
    document.body.classList.remove('no-scroll');
    this.miniMap.destroy();
    if (this.returnFocus instanceof HTMLElement) this.returnFocus.focus();
  }

  private q<T extends HTMLElement = HTMLElement>(sel: string): T {
    return this.root.querySelector<T>(sel)!;
  }

  private get photo(): Photo {
    return this.opts.list[this.pos];
  }

  private step(delta: number, user: boolean) {
    const n = this.opts.list.length;
    this.pos = (this.pos + delta + n) % n;
    if (user && this.playing) this.restartTimer();
    this.show();
    this.opts.onNavigate(this.photo);
  }

  private show() {
    const { album, list } = this.opts;
    const p = this.photo;
    const img = this.q<HTMLImageElement>('.viewer-img');
    img.src = p.displayUrl;
    img.alt = photoAlt(album, p);
    img.width = p.width;
    img.height = p.height;
    this.q('.viewer-count').textContent = `${this.pos + 1} / ${list.length}`;
    // preload neighbours
    for (const d of [1, -1]) new Image().src = list[(this.pos + d + list.length) % list.length].displayUrl;
    if (this.infoOpen) this.renderInfo();
  }

  private renderInfo() {
    const { album } = this.opts;
    const p = this.photo;
    const place = album.placeById.get(p.placeId);
    const lang = album.localLanguage?.code ?? '';
    const coords = p.lat != null && p.lon != null ? `${p.lat.toFixed(5)}, ${p.lon.toFixed(5)}` : null;
    const info = this.q('.viewer-info');
    info.innerHTML = `
      ${p.caption ? `<p class="caption">${esc(p.caption)}</p>` : ''}
      ${p.motion ? `<span class="badge" title="Pixel Motion Photo: the original includes a short video clip">Motion Photo</span>` : ''}
      ${
        place
          ? `<h2 class="place-name">${esc(place.name)}</h2>
             ${place.nameLocal ? `<div class="local" lang="${esc(lang)}">${esc(place.nameLocal)}</div>` : ''}
             ${place.area && place.area !== place.name ? `<div class="muted">${esc(place.area)}</div>` : ''}
             ${place.description ? `<p class="description">${esc(place.description)}</p>` : ''}
             ${eventListHtml(album, eventsFor(album, place.id, p.day), 'Happening here')}`
          : ''
      }
      <dl class="facts">
        ${isDated(p.day) ? `<dt>Taken</dt><dd>${esc(dayLabel(p.day, true))}, ${esc(p.time)} ${esc(album.timeZoneLabel ?? '')}</dd>` : ''}
        ${
          coords
            ? `<dt>Location</dt><dd>${esc(coords)}<br>
               <a href="https://www.google.com/maps/search/?api=1&query=${p.lat},${p.lon}" target="_blank" rel="noopener">Google Maps</a> ·
               <a href="https://www.openstreetmap.org/?mlat=${p.lat}&mlon=${p.lon}#map=17/${p.lat}/${p.lon}" target="_blank" rel="noopener">OpenStreetMap</a></dd>`
            : ''
        }
        ${p.alt != null ? `<dt>Altitude</dt><dd>${esc(Math.round(p.alt))} m</dd>` : ''}
        ${p.camera ? `<dt>Camera</dt><dd>${esc(p.camera)}</dd>` : ''}
        <dt>File</dt><dd class="file">${esc(p.file)}</dd>
      </dl>
      ${coords ? `<div class="mini-map" aria-label="Map showing where this photo was taken"></div>` : ''}`;
    const mm = info.querySelector<HTMLElement>('.mini-map');
    if (mm && p.lat != null && p.lon != null) this.miniMap.show(mm, p.lat, p.lon);
    else this.miniMap.destroy();
  }

  private setPlaying(on: boolean) {
    this.playing = on;
    const btn = this.q('.play');
    btn.textContent = on ? '❚❚ Pause' : '▶ Slideshow';
    btn.setAttribute('aria-pressed', String(on));
    this.root.classList.toggle('playing', on);
    if (on) this.restartTimer();
    else window.clearInterval(this.timer);
  }

  private restartTimer() {
    window.clearInterval(this.timer);
    const bar = this.q('.viewer-progress span');
    bar.style.animation = 'none';
    void bar.offsetWidth; // restart the CSS animation
    bar.style.animation = `progress ${SLIDE_MS}ms linear infinite`;
    this.timer = window.setInterval(() => this.step(1, false), SLIDE_MS);
  }

  private trapFocus(e: KeyboardEvent) {
    const els = [...this.root.querySelectorAll<HTMLElement>('button, a[href]')].filter((el) => el.offsetParent !== null);
    if (els.length === 0) return;
    const first = els[0];
    const last = els[els.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }
}
