/*
 * The AUROR demo's TV: Glasshouse's /api/home/* answered in the browser, so
 * the real view runs on GitHub Pages with made-up apps, inputs, Jellyfin
 * shows and settings that are kept for as long as the page is open.
 *
 * Loaded before the view's own scripts. It stands in for XMLHttpRequest:
 * /api/ and /jellyfin/ are answered here, and /assets/ is fetched from beside
 * the page, since Pages serves the demo below the site's root.
 *
 * ?scenario=inputs adds a games console on HDMI 2; the view's own ?hour= and
 * ?lang= work as on the TV.
 */
(function () {
  var Q = location.search;
  var scenario = (/[?&]scenario=(\w+)/.exec(Q) || [])[1] || 'apps';
  var POSTER = function (i) { return 'demo/poster' + i + '.svg'; };

  // As a TV with AUROR lists them: the streaming services and Glasshouse's own app are hidden when first seen.
  var apps = [
    { id: 'com.webos.app.browser', title: 'Web Browser' },
    { id: 'org.jellyfin.webos', title: 'Jellyfin' },
    { id: 'youtube.leanback.v4', title: 'YouTube' },
    { id: 'spotify-beehive', title: 'Spotify' },
    { id: 'com.tvweb.dashboard', title: 'Glasshouse' },
    { id: 'com.valvesoftware.steamlink', title: 'Steam Link' },
    { id: 'netflix', title: 'Netflix' },
    { id: 'amazon', title: 'Prime Video' },
    { id: 'com.disney.disneyplus-prod', title: 'Disney+' },
    { id: 'dazn', title: 'DAZN' },
    { id: 'it.sky.now', title: 'NOW' },
    { id: 'com.webos.app.lgchannels', title: 'LG Channels' }
  ].map(function (a) { a.icon = null; return a; });
  var devices = scenario === 'inputs' ? [
    { id: 'hdmi2:playstation-5', name: 'PlayStation 5', input: 'hdmi2', port: 2, via: null, address: '2.0.0.0' },
    { id: 'hdmi1', name: 'HDMI 1', input: 'hdmi1', port: 1, via: null, address: null, unused: true },
    { id: 'hdmi3', name: 'HDMI 3', input: 'hdmi3', port: 3, via: null, address: null, unused: true }
  ] : [
    { id: 'hdmi1', name: 'HDMI 1', input: 'hdmi1', port: 1, via: null, address: null, unused: true }
  ];
  var layout = {
    rows: ['app', 'dev', 'ch'], sort: { app: 'custom', dev: 'custom', ch: 'custom' },
    hidden: { app: ['netflix', 'amazon', 'com.disney.disneyplus-prod', 'dazn', 'it.sky.now', 'com.webos.app.lgchannels', 'com.tvweb.dashboard'], dev: [], ch: [] },
    order: { app: [], dev: [], ch: [] }, folder: [], channels: [], hintSeen: true, searchHintSeen: true, search: true,
    hideUnused: true, picture: false, colours: null,
    look: { theme: 'auto', mascots: true, saverBright: false, shelf: { jellyfin: true, glasshouse: true, hdmi: true } }
  };
  var saver = { mode: 'auror', level: 'dim', available: true };
  var update = { auto: true, installed: '0.122.101', latest: '0.122.101', available: false };
  var jellyfin = { linked: true };
  var tmdb = { linked: true };
  // Immich's albums: the build's landscapes and posters stand in for the photos.
  var immich = { linked: true };
  var ALBUMS = [
    { id: 'a1', name: 'Estate al lago', cover: 'photo1', from: '2026-07-12', to: '2026-07-26', places: ['Garda', 'Malcesine', 'Riva del Garda'] },
    { id: 'a2', name: 'Montagna', cover: 'photo2', from: '2026-02-01', to: '2026-02-08', places: ['Cortina d’Ampezzo', 'Dobbiaco'] },
    { id: 'a3', name: 'Tramonti', cover: 'photo0', from: '2024-05-03', to: '2026-09-30', places: ['Verona', 'Venezia', null] },
    { id: 'a4', name: 'Notti stellate', cover: 'photo3', from: '2025-08-10', to: '2025-08-12', places: ['Lessinia'] },
    { id: 'a5', name: 'Serate cinema', cover: 'poster3', from: '2025-11-01', to: '2026-03-15', places: [null] }
  ];
  var PICS = ['photo0', 'photo1', 'photo2', 'photo3', 'poster0', 'poster1', 'poster2', 'poster3', 'poster4', 'poster5'];
  function albumAssets(a) {
    var out = [], n = a.id === 'a3' ? 64 : 18 + a.name.length;
    for (var i = 0; i < n; i++) {
      var d = new Date(Date.parse(a.to) - i * 86400000 * (a.id === 'a3' ? 13 : 0.6));
      out.push({ id: i ? PICS[(i + a.name.length) % PICS.length] : a.cover, video: false, date: d.toISOString().slice(0, 10), place: a.places[i % a.places.length] });
    }
    return out;
  }
  // The top bar's network, sleep timer and the SSH settings, as lib/auror-tv answers.
  var net = { ok: true, kind: 'wifi', state: 'online', ssid: 'Casa', ip: '192.168.1.42' };
  var sleepAt = 0;
  var ssh = { ok: true, enabled: false, running: false, keys: 1, passwordNow: false, passwordAfterReboot: false };
  // AUROR's photos, as lib/auror-gallery keeps them: four landscapes made by the build.
  var gallery = { mode: 'off', photo: null, every: 30, ids: ['photo0', 'photo1', 'photo2', 'photo3'] };
  // Most used, as the server keeps it: opens, here only those made in the demo.
  var opens = {};
  var version = 1;

  function copy(o) { return JSON.parse(JSON.stringify(o)); }
  function merge(into, from) {
    for (var k in from) {
      if (from[k] && typeof from[k] === 'object' && !(from[k] instanceof Array)) { into[k] = into[k] || {}; merge(into[k], from[k]); }
      else into[k] = from[k];
    }
  }
  function appOrder() {
    var ids = apps.map(function (a) { return a.id; });
    if (layout.order.app.length) {
      var kept = layout.order.app.filter(function (id) { return ids.indexOf(id) !== -1; });
      ids = kept.concat(ids.filter(function (id) { return kept.indexOf(id) === -1; }));
    }
    if (layout.sort.app === 'use' || layout.sort.app === 'recent') {
      ids = ids.map(function (id, i) { return { id: id, i: i, n: opens[id] || 0 }; })
        .sort(function (x, y) { return y.n - x.n || x.i - y.i; }).map(function (x) { return x.id; });
    }
    return ids.concat(immich.linked ? ['auror-immich'] : [], 'lg-home');
  }
  function sleepStatus() {
    var left = Math.max(0, sleepAt - Date.now());
    if (!left) sleepAt = 0;
    return { ok: true, minutes: Math.ceil(left / 60000), left: left, at: sleepAt || null };
  }
  function galleryShown() {
    var ids = gallery.ids;
    if (gallery.mode === 'off' || !ids.length) return null;
    if (gallery.mode === 'one') return ids.indexOf(gallery.photo) !== -1 ? gallery.photo : ids[ids.length - 1];
    return ids[Math.floor(Date.now() / (gallery.every * 60000)) % ids.length];
  }
  function galleryStatus() {
    return { ok: true, mode: gallery.mode, photo: gallery.photo, every: gallery.every, shown: galleryShown(),
      count: gallery.ids.length, max: 60, ids: gallery.ids.slice() };
  }
  function wallpapers() {
    var shown = galleryShown();
    if (!shown) return { available: false };
    return { available: true, uploading: false, revision: 'p-' + shown, src: 'demo/' + shown + '.svg',
      slots: { morning: true, afternoon: true, evening: true, night: true } };
  }
  function catalogue() {
    return { ok: true, apps: apps, devices: devices, channels: [],
      order: { app: appOrder(), dev: devices.map(function (d) { return d.id; }), ch: [] },
      sources: { apps: true, devices: true, channels: 0 }, layout: copy(layout), enabled: true,
      wallpapers: wallpapers(), layoutVersion: 'v' + version,
      jellyfin: jellyfin.linked ? { ok: true, configured: true, server: 'jellyfin.example.org', user: 'Demo' } : { ok: true, configured: false },
      saver: saver, update: update, tmdb: { ok: true, configured: tmdb.linked }, immich: immichStatus() };
  }
  function immichStatus() {
    return immich.linked ? { ok: true, configured: true, server: 'immich.example.org', user: 'Demo' } : { ok: true, configured: false };
  }
  function shelf() {
    if (!jellyfin.linked) return { ok: true, state: 'off', items: [] };
    return { ok: true, state: 'resume', items: [
      { title: 'Orbite basse', kind: 'episode', season: 2, episode: 4, name: 'Il segnale', year: null, progress: 70, image: POSTER(0) },
      { title: 'Casa sul lago', kind: 'episode', season: 1, episode: 7, name: 'Inverno', year: null, progress: 35, image: POSTER(1) },
      { title: 'Nebbia d’agosto', kind: 'movie', season: null, episode: null, name: '', year: 2022, progress: 15, image: POSTER(2) }] };
  }
  // As AUROR's search answers: Jellyfin's own first, then where each is to watch in Italy.
  function search(q) {
    var jf = { id: 'org.jellyfin.webos', title: 'Jellyfin', icon: null };
    var nf = { id: 'netflix', title: 'Netflix', icon: null }, pv = { id: 'amazon', title: 'Prime Video', icon: null };
    var all = [
      { title: 'Orbite basse', kind: 'series', year: 2025, genre: 'Fantascienza, Dramma', poster: POSTER(0), apps: [jf], also: [], rent: [], buy: [] },
      { title: 'Il faro del nord', kind: 'film', year: 2024, minutes: 112, genre: 'Giallo', poster: POSTER(3), apps: [nf], also: ['NOW'], rent: ['Apple TV', 'Chili'], buy: [] },
      { title: 'Cronache di vetro', kind: 'series', year: 2023, genre: 'Documentario', poster: POSTER(4), apps: [pv], also: ['RaiPlay'], rent: [], buy: [] },
      { title: 'La valle lenta', kind: 'film', year: 2021, minutes: 98, genre: 'Commedia', poster: POSTER(5), apps: [], also: [], rent: ['Apple TV', 'Rakuten TV'], buy: ['Apple TV'] }
    ];
    var words = String(q || '').toLowerCase();
    var hits = all.filter(function (h) { return !words || h.title.toLowerCase().indexOf(words) !== -1 || h.genre.toLowerCase().indexOf(words) !== -1; });
    if (!hits.length) hits = all;
    return { ok: true, query: q, elsewhere: 1, tmdb: tmdb.linked, jellyfin: true, delay: 500, results: hits.map(function (h, i) {
      h.id = 'demo.' + i; h.rating = null; h.minutes = h.minutes || null;
      return h;
    }) };
  }
  var DEMO_ONLY = 'Nella demo non si apre niente: sulla TV partirebbe questo.';

  function answer(method, url, body) {
    var path = url.split('?')[0], b = {};
    try { b = body ? JSON.parse(body) : {}; } catch (e) {}
    switch (path) {
      case '/api/home/catalogue': return catalogue();
      case '/api/home/now': return { kind: 'app', appId: 'youtube.leanback.v4', title: 'YouTube', since: Date.now() - 600000 };
      case '/api/home/beat': return { ok: true, enabled: true, build: 'demo', wallpapers: wallpapers(), layoutVersion: 'v' + version };
      case '/api/home/network': return net;
      case '/api/home/sleep':
        if (method === 'GET') return sleepStatus();
        var steps = [30, 60, 90, 120], left = sleepStatus().minutes, next = 0;
        for (var s = 0; s < steps.length; s++) if (steps[s] > left) { next = steps[s]; break; }
        sleepAt = next ? Date.now() + next * 60000 : 0;
        return sleepStatus();
      case '/api/home/poweroff': return { ok: false, error: 'Nella demo la TV resta accesa.' };
      case '/api/home/ssh':
        if (method === 'POST') { ssh.enabled = ssh.running = b.on === true; ssh.delay = 600; }
        return ssh;
      case '/api/home/gallery':
      case '/photos/list':
      case '/photos/settings':
      case '/photos/use':
      case '/photos/remove':
        if (path === '/photos/use') { gallery.mode = 'one'; gallery.photo = b.id; }
        if (path === '/photos/remove') gallery.ids = gallery.ids.filter(function (id) { return id !== b.id; });
        if (method === 'POST') ['mode', 'photo', 'every'].forEach(function (k) { if (b[k] !== undefined) gallery[k] = b[k]; });
        var st = galleryStatus();
        st.wallpapers = wallpapers();
        return st;
      case '/api/home/immich/status': return immichStatus();
      case '/api/home/immich/albums':
        return { ok: true, albums: ALBUMS.map(function (a) {
          return { id: a.id, name: a.name, count: albumAssets(a).length, cover: a.cover, from: a.from, to: a.to, shared: false };
        }) };
      case '/api/home/immich/album':
        var wanted = (/[?&]id=([^&]+)/.exec(url) || [])[1], hit = null;
        ALBUMS.forEach(function (a) { if (a.id === wanted) hit = a; });
        if (!hit) return { ok: false, error: 'that album is not on Immich', status: 400 };
        var assets = albumAssets(hit);
        return { ok: true, id: hit.id, name: hit.name, count: assets.length, assets: assets, delay: 300 };
      case '/api/home/immich/pair': return { ok: true, url: location.href.replace(/[^/]*$/, '') + 'immich.html?c=demo' };
      case '/api/home/immich/forget': immich.linked = false; version++; return { ok: true, configured: false };
      case '/immich/link':
        if (b.check) return { ok: true, valid: true };
        immich.linked = true;
        version++;
        return { ok: true, user: 'Demo', albums: ALBUMS.length };
      case '/api/home/gallery/pair': return { ok: true, url: location.href.replace(/[^/]*$/, '') + 'photos.html?c=demo' };
      case '/photos/upload': return { ok: false, error: 'Nella demo le foto non si caricano: sulla TV finirebbero qui.', status: 400 };
      case '/api/home/guide': return { ok: true, guide: {} };
      case '/api/home/picture': return { ok: false };
      case '/api/home/jellyfin': return shelf();
      case '/api/home/jellyfin/status': return catalogue().jellyfin;
      case '/api/home/jellyfin/pair': return { ok: true, url: location.href.replace(/[^/]*$/, '') + 'jellyfin.html?c=demo' };
      case '/api/home/jellyfin/forget': jellyfin.linked = false; return { ok: true, configured: false };
      case '/api/stats': return { ok: true, temp: 52.4, load: 11, mem: { total: 3000000, avail: 1290000 }, wifi: { link: 70, level: -58 } };
      case '/api/home/recents':
        if (method === 'GET') return { ok: true, apps: [{ id: 'org.jellyfin.webos', title: 'Jellyfin', image: false }, { id: 'youtube.leanback.v4', title: 'YouTube', image: false }] };
        return { ok: true };
      case '/api/home/look':
        if (method === 'GET') return { ok: true, look: layout.look };
        merge(layout.look, b); version++;
        return { ok: true, layout: copy(layout), layoutVersion: 'v' + version };
      case '/api/home/layout':
        if (b.reset) { layout.order = { app: [], dev: [], ch: [] }; layout.sort = { app: 'custom', dev: 'custom', ch: 'custom' }; }
        ['rows', 'folder'].forEach(function (k) { if (b[k]) layout[k] = b[k]; });
        if (b.reset) layout.folder = [];
        ['order', 'sort', 'hidden'].forEach(function (k) { if (b[k]) for (var r in b[k]) layout[k][r] = b[k][r]; });
        for (var k in b) if (typeof b[k] === 'boolean') layout[k] = b[k];
        version++;
        return { ok: true, layout: copy(layout), layoutVersion: 'v' + version };
      case '/api/home/screensaver':
        saver.mode = b.on ? 'auror' : 'stock'; saver.level = b.bright ? 'bright' : 'dim';
        return { ok: true, current: saver.mode, level: saver.level, delay: 600 };
      case '/api/home/autoupdate': update.auto = b.auto === true; return { ok: true, update: update };
      case '/api/home/updatenow': return { ok: true, installing: false, update: update, delay: 900 };
      case '/api/home/search': return search(b.query);
      case '/api/home/search/pair': return { ok: true, url: location.href.replace(/[^/]*$/, '') + 'tmdb.html?c=demo' };
      case '/api/home/search/status': return { ok: true, configured: tmdb.linked };
      case '/api/home/search/forget': tmdb.linked = false; return { ok: true, configured: false };
      case '/tmdb/link':
        if (b.check) return { ok: true, valid: true };
        tmdb.linked = true;
        return { ok: true };
      case '/api/home/search/open': return { ok: false, error: DEMO_ONLY };
      case '/api/home/open':
        if (b.kind === 'app' && b.id) opens[b.id] = (opens[b.id] || 0) + 1;
        return { ok: false, error: DEMO_ONLY };
      case '/jellyfin/link':
        if (b.check) return { ok: true, valid: true };
        if (!b.user) return { ok: false, needUser: true, users: [{ id: 'u1', name: 'Demo' }, { id: 'u2', name: 'Ospite' }] };
        jellyfin.linked = true;
        return { ok: true, user: 'Demo' };
    }
    return { ok: false, error: 'not in the demo', status: 404 };
  }

  var Real = window.XMLHttpRequest;
  function DemoRequest() {
    this.readyState = 0; this.status = 0; this.responseText = ''; this.timeout = 0;
    this.onload = this.onerror = this.ontimeout = this.onreadystatechange = null;
  }
  DemoRequest.DONE = 4;
  DemoRequest.prototype.open = function (method, url, async) {
    this._method = method;
    this._url = String(url);
    this._fake = /^\/(api|jellyfin|tmdb|photos|immich)\//.test(this._url);
    if (this._fake) return;
    var self = this, r = this._real = new Real();
    r.open(method, this._url.replace(/^\/assets\//, 'assets/'), async !== false);
    r.onreadystatechange = function () {
      self.readyState = r.readyState;
      if (r.readyState !== 4) return;
      self.status = r.status;
      self.responseText = r.responseText;
      if (self.onreadystatechange) self.onreadystatechange();
      if (self.onload) self.onload();
    };
  };
  DemoRequest.prototype.setRequestHeader = function (k, v) { if (!this._fake) this._real.setRequestHeader(k, v); };
  DemoRequest.prototype.abort = function () { if (!this._fake) this._real.abort(); };
  DemoRequest.prototype.send = function (body) {
    if (!this._fake) {
      this._real.send(body === undefined ? null : body);
      // A synchronous request, as i18n.js makes, is done here.
      if (this._real.readyState === 4) { this.readyState = 4; this.status = this._real.status; this.responseText = this._real.responseText; }
      return;
    }
    var self = this, out = answer(this._method, this._url, body), delay = out.delay || 60;
    var status = out.status || 200;
    delete out.delay; delete out.status;
    setTimeout(function () {
      self.readyState = 4;
      self.status = status;
      self.responseText = JSON.stringify(out);
      if (self.onreadystatechange) self.onreadystatechange();
      if (self.onload) self.onload();
    }, delay);
  };
  window.XMLHttpRequest = DemoRequest;

  // A computer has no Back key: Esc is Back, and Backspace too outside the search field.
  ['keydown', 'keyup'].forEach(function (type) {
    window.addEventListener(type, function (e) {
      if (e.demoBack) return;
      var typing = e.target && e.target.tagName === 'INPUT';
      if (!(e.key === 'Escape' || (e.key === 'Backspace' && !typing))) return;
      e.stopImmediatePropagation();
      e.preventDefault();
      var back = document.createEvent('Event');
      back.initEvent(type, true, true);
      back.keyCode = back.which = 461;
      back.demoBack = true;
      (e.target || document).dispatchEvent(back);
    }, true);
  });
})();
