/*
 * lib/auror-search.js - AUROR's search on Glasshouse Home (lib/home): films
 * and series in the Jellyfin library linked, and where each is to watch in
 * Italy, without asking LG.
 *
 * TMDB answers the titles, and for each one which services stream, rent or
 * sell it in Italy, from JustWatch's data, which TMDB asks to be credited.
 * A title is offered on the services this TV has an app for, and on
 * Jellyfin where the library has it, by the TMDB id Jellyfin keeps for it
 * or else by its name and year; the others are named. TMDB gives no title's
 * id on the service itself, so OK opens the app, not the title.
 *
 * TMDB needs an API key of the owner's (free, from themoviedb.org), linked
 * from a phone like Jellyfin and kept in tmdb.json beside jellyfin.json.
 * Without one, only Jellyfin is searched. The requests go out with
 * lib/fetch's curl or wget, whose certificates are the TV's own and newer
 * than node 0.12's.
 *
 * The same calls as lib/home-search, which this stands in for: find, open,
 * blocked (never: LG is not asked).
 *
 * Strict ES5: runs on node 0.12.
 */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var util = require('./util');
var msg = require('./say').msg;

var API = 'https://api.themoviedb.org/3';
var IMAGES = 'https://image.tmdb.org/t/p/';
var REGION = 'IT';
var LANGUAGE = 'it-IT';
var CONFIG_FILE = 'tmdb.json';
// The titles asked about in full, each one more request.
var TITLES = 8;
var DETAIL_TTL_MS = 6 * 3600000;
var DETAIL_MAX = 300;
// What TMDB found for a query: typing asks again at each pause.
var QUERY_TTL_MS = 30 * 60000;
var QUERY_MAX = 50;
var CODE_TTL_MS = 10 * 60000;
var JELLYFIN_APP = /jellyfin/i;

/*
 * A service's name, as JustWatch gives it and as the TV lists its app, cut
 * to what both share: "Amazon Prime Video with Ads" and "Prime Video" are
 * both primevideo.
 */
/** @type {Array<Array<any>>} */
var ALIASES = [
  [/^amazonprimevideo|^primevideo|^amazonvideo/, 'primevideo'],
  [/^disney/, 'disney'],
  [/^netflix/, 'netflix'],
  [/^now(tv)?$|^nowtv/, 'now'],
  [/^paramount/, 'paramount'],
  [/^appletv/, 'appletv'],
  [/^raiplay/, 'raiplay'],
  [/^mediaset|^infinity/, 'mediaset'],
  [/^timvision/, 'timvision'],
  [/^rakuten/, 'rakuten'],
  [/^skygo|^sky$/, 'sky'],
  [/^discovery/, 'discovery'],
  [/^crunchyroll/, 'crunchyroll'],
  [/^mubi/, 'mubi'],
  [/^youtube/, 'youtube'],
  [/^googleplay/, 'googleplay'],
  [/^plutotv/, 'pluto'],
  [/^plex/, 'plex']
];

var stateDir = '/var/lib/tvweb';
var nowMs = Date.now;
var getJson = null;
var jellyfin = null;
var appsFn = function (cb) { cb([]); };
var launchFn = null;
/** @type {function(string): void} */
var openedFn = function () {};
var enabledFn = function () { return true; };
var cfg = null;
var details = {};
var queries = {};
var codes = {};
// What the last search offered: only those can be opened.
var listed = {};
var generation = 0;

function init(opts) {
  opts = opts || {};
  stateDir = opts.stateDir || stateDir;
  nowMs = opts.now || Date.now;
  getJson = opts.getJson || require('./fetch').getJson;
  jellyfin = opts.jellyfin || null;
  if (opts.apps) appsFn = opts.apps;
  launchFn = opts.launch || null;
  if (opts.opened) openedFn = opts.opened;
  if (opts.enabled) enabledFn = opts.enabled;
  cfg = null;
  details = {};
  queries = {};
  codes = {};
  listed = {};
}

// Kept in a map of at most max, the oldest going first.
function keep(map, key, value, max) {
  var keys = Object.keys(map);
  if (keys.length >= max) {
    keys.sort(function (a, b) { return map[a].at - map[b].at; });
    keys.slice(0, keys.length - max + 1).forEach(function (k) { delete map[k]; });
  }
  map[key] = { at: nowMs(), value: value };
}

function file() { return path.join(stateDir, CONFIG_FILE); }

function config() {
  if (cfg) return cfg.key ? cfg : null;
  cfg = {};
  try {
    var raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (raw && typeof raw.key === 'string' && /^[0-9a-f]{32}$/i.test(raw.key)) cfg = { key: raw.key };
  } catch (e) {}
  return cfg.key ? cfg : null;
}

function isArray(v) { return Object.prototype.toString.call(v) === '[object Array]'; }

function squash(s) {
  return String(s || '').toLowerCase().replace(/\+/g, 'plus').replace(/[^a-z0-9]+/g, '');
}

function serviceKey(name) {
  var s = squash(name);
  for (var i = 0; i < ALIASES.length; i++) if (ALIASES[i][0].test(s)) return ALIASES[i][1];
  return s;
}

// The TV's apps by service: { primevideo: { id, title, icon } }.
function appsByService(apps) {
  var out = {};
  (apps || []).forEach(function (a) {
    var k = serviceKey(a.title);
    if (k && !out[k]) out[k] = { id: a.id, title: a.title, icon: a.icon ? '/api/home/icon?id=' + encodeURIComponent(a.id) : null };
  });
  return out;
}

function tmdb(c, pathAndQuery, cb) {
  var url = API + pathAndQuery + (pathAndQuery.indexOf('?') === -1 ? '?' : '&') + 'api_key=' + c.key;
  getJson(url, function (err, body) { cb(err || null, body || null); });
}

function yearOf(date) {
  var m = /^(\d{4})/.exec(String(date || ''));
  return m ? +m[1] : null;
}

// One title in full, with where it is in Italy; kept six hours.
function detail(c, kind, id, cb) {
  var key = kind + ':' + id, hit = details[key];
  if (hit && nowMs() - hit.at < DETAIL_TTL_MS) return cb(hit.value);
  tmdb(c, '/' + kind + '/' + id + '?language=' + LANGUAGE + '&append_to_response=watch/providers', function (err, body) {
    if (err || !body || !body.id) return cb(null);
    keep(details, key, body, DETAIL_MAX);
    cb(body);
  });
}

function names(list) {
  var seen = {}, out = [];
  (isArray(list) ? list : []).forEach(function (p) {
    var n = p && String(p.provider_name || ''), k = serviceKey(n);
    if (n && !seen[k]) { seen[k] = true; out.push({ key: k, name: n }); }
  });
  return out;
}

/*
 * A TMDB title as the view shows a hit: apps to open it on, the services
 * that stream it with no app here, and those that rent or sell it.
 */
function fromTmdb(d, kind, apps) {
  var where = (d['watch/providers'] && d['watch/providers'].results && d['watch/providers'].results[REGION]) || {};
  var stream = names([].concat(where.flatrate || [], where.free || [], where.ads || []));
  var onApps = [], also = [];
  stream.forEach(function (s) {
    var app = apps[s.key];
    if (app) onApps.push({ id: app.id, title: app.title, icon: app.icon });
    else also.push(s.name);
  });
  var streamed = {};
  stream.forEach(function (s) { streamed[s.key] = true; });
  var paid = function (list) { return names(list).filter(function (s) { return !streamed[s.key]; }).map(function (s) { return s.name; }); };
  var runtime = kind === 'movie' ? d.runtime : isArray(d.episode_run_time) ? d.episode_run_time[0] : null;
  var picture = d.backdrop_path ? IMAGES + 'w780' + d.backdrop_path : d.poster_path ? IMAGES + 'w342' + d.poster_path : null;
  return {
    tmdb: d.id, title: String(d.title || d.name || ''), original: String(d.original_title || d.original_name || ''),
    kind: kind === 'movie' ? 'film' : 'series', year: yearOf(d.release_date || d.first_air_date),
    minutes: typeof runtime === 'number' && runtime > 0 ? runtime : null,
    genre: (isArray(d.genres) ? d.genres : []).map(function (g) { return g && g.name; }).filter(Boolean).slice(0, 3).join(', ') || null,
    rating: null, poster: picture, apps: onApps, also: also, rent: paid(where.rent), buy: paid(where.buy)
  };
}

function tmdbFind(query, apps, cb) {
  var c = config();
  if (!c) return cb(null);
  var asked = squash(query), hit = queries[asked];
  if (hit && nowMs() - hit.at < QUERY_TTL_MS) return found(null, hit.value);
  tmdb(c, '/search/multi?language=' + LANGUAGE + '&region=' + REGION + '&include_adult=false&query=' + encodeURIComponent(query), found);
  function found(err, body) {
    if (err || !body || !isArray(body.results)) return cb(err ? false : []);
    if (!hit) keep(queries, asked, body, QUERY_MAX);
    var wanted = body.results.filter(function (r) { return r && (r.media_type === 'movie' || r.media_type === 'tv') && r.id; }).slice(0, TITLES);
    var out = new Array(wanted.length), left = wanted.length;
    if (!left) return cb([]);
    wanted.forEach(function (r, i) {
      detail(c, r.media_type, r.id, function (d) {
        out[i] = d ? fromTmdb(d, r.media_type, apps) : null;
        if (--left === 0) cb(out.filter(Boolean));
      });
    });
  }
}

function jellyfinFind(query, cb) {
  if (!jellyfin || !jellyfin.search) return cb(null);
  jellyfin.search(query, function (items) { cb(items); });
}

// The same title in the library: by the TMDB id Jellyfin keeps, else by name and year.
function sameTitle(item, hit) {
  if (item.tmdb && String(item.tmdb) === String(hit.tmdb)) return true;
  if (item.kind !== hit.kind) return false;
  var name = squash(item.title);
  if (name !== squash(hit.title) && name !== squash(hit.original)) return false;
  return !item.year || !hit.year || Math.abs(item.year - hit.year) <= 1;
}

function find(query, cb) {
  query = String(query || '').trim().slice(0, 80);
  if (!enabledFn()) return cb({ ok: false, error: msg('srv.home.searchOff', 'search is switched off in Glasshouse Home\'s settings') });
  if (!query) return cb({ ok: true, query: query, results: [], elsewhere: 0 });
  var mine = ++generation;
  appsFn(function (apps) {
    var byService = appsByService(apps), jfApp = null;
    (apps || []).forEach(function (a) { if (!jfApp && JELLYFIN_APP.test(a.title)) jfApp = a; });
    var got = { tmdb: undefined, jellyfin: undefined };
    tmdbFind(query, byService, function (r) { got.tmdb = r; done(); });
    jellyfinFind(query, function (r) { got.jellyfin = r; done(); });
    function done() {
      if (got.tmdb === undefined || got.jellyfin === undefined || mine !== generation) return;
      if (got.tmdb === false && !got.jellyfin) return cb({ ok: false, error: msg('srv.home.tmdbFailed', 'TMDB did not answer') });
      var hits = (got.tmdb || []).slice(), own = [];
      var chip = jfApp && { id: jfApp.id, title: jfApp.title, icon: jfApp.icon ? '/api/home/icon?id=' + encodeURIComponent(jfApp.id) : null };
      (got.jellyfin || []).forEach(function (item) {
        /** @type {any} */
        var hit = null;
        hits.forEach(function (h) { if (!hit && sameTitle(item, h)) hit = h; });
        if (hit) { if (chip && !hit.jellyfin) { hit.apps.unshift(chip); hit.jellyfin = true; } return; }
        own.push({ title: item.title, kind: item.kind, year: item.year, minutes: item.minutes, genre: item.genre || null, rating: null,
          poster: item.image, apps: chip ? [chip] : [], also: [], rent: [], buy: [], jellyfin: true });
      });
      // The library's own first; then what is to watch here; then what is only rented, sold or not here at all.
      var watchable = hits.filter(function (h) { return h.apps.length || h.also.length; });
      var rest = hits.filter(function (h) { return !h.apps.length && !h.also.length; });
      var out = own.concat(watchable, rest.filter(function (h) { return h.rent.length || h.buy.length; }));
      var elsewhere = rest.filter(function (h) { return !h.rent.length && !h.buy.length; }).length;
      listed = {};
      cb({ ok: true, query: query, elsewhere: elsewhere, tmdb: !!config(), jellyfin: got.jellyfin !== null,
        results: out.map(function (h, i) {
          var id = mine + '.' + i;
          listed[id] = h.apps.map(function (a) { return a.id; });
          return { id: id, title: h.title, kind: h.kind, year: h.year, minutes: h.minutes, genre: h.genre, rating: h.rating,
            poster: h.poster, apps: h.apps, also: h.also, rent: h.rent, buy: h.buy };
        }) });
    }
  });
}

// { id, app }: an app the last search offered for that title, opened at its start.
function open(body, cb) {
  var id = body && String(body.id || ''), app = body && String(body.app || '');
  if (!listed.hasOwnProperty(id) || listed[id].indexOf(app) === -1) {
    return cb({ ok: false, error: msg('srv.home.searchGone', 'that is no longer in the results') });
  }
  if (!launchFn) return cb({ ok: false, error: 'no launcher' });
  launchFn(app, null, function (r) {
    if (r && r.ok) openedFn(app);
    cb(r);
  });
}

function blocked() { return null; }

function status() { return { ok: true, configured: !!config() }; }

function pair(origin) {
  if (!origin) return { ok: false, error: msg('srv.home.jfNoNetwork', 'the TV has no address a phone can reach') };
  var now = nowMs();
  for (var k in codes) if (codes[k] < now) delete codes[k];
  var code = crypto.randomBytes(8).toString('hex');
  codes[code] = now + CODE_TTL_MS;
  return { ok: true, url: origin + '/tmdb?c=' + code, expiresIn: CODE_TTL_MS };
}

function codeValid(code) {
  return typeof code === 'string' && codes.hasOwnProperty(code) && codes[code] >= nowMs();
}

/*
 * From the phone: { c, key }, or { c, check: true } as its page opens. The
 * key is tried with TMDB before it is kept.
 */
function link(body, cb) {
  if (!body || !codeValid(body.c)) return cb({ ok: false, expired: true, error: msg('srv.home.tmdbExpired', 'This code has expired. Open Search in the TV\'s Home settings for a new one.') });
  if (body.check === true) return cb({ ok: true, valid: true });
  var key = String(body.key || '').trim();
  if (!/^[0-9a-f]{32}$/i.test(key)) return cb({ ok: false, error: msg('srv.home.tmdbKey', 'a TMDB API key is 32 letters and digits, from themoviedb.org, Settings, API') });
  tmdb({ key: key }, '/configuration', function (err, conf) {
    if (err || !conf || !conf.images) {
      return cb({ ok: false, error: err ? msg('srv.home.tmdbRefused', 'TMDB refused the key, or did not answer: {error}', { error: err.message }) : msg('srv.home.tmdbBad', 'TMDB did not take the key') });
    }
    try {
      util.writeJsonAtomic(file(), { key: key }, 384);
    } catch (e) {
      return cb({ ok: false, error: msg('srv.home.tmdbSaveFailed', 'could not save the TMDB key') });
    }
    delete codes[body.c];
    cfg = null;
    details = {};
    queries = {};
    console.log('home: TMDB linked from a phone');
    cb({ ok: true });
  });
}

function forget(cb) {
  util.unlinkQuiet(file());
  cfg = null;
  details = {};
  queries = {};
  cb({ ok: true, configured: false });
}

module.exports = {
  init: init,
  find: find,
  open: open,
  blocked: blocked,
  status: status,
  pair: pair,
  codeValid: codeValid,
  link: link,
  forget: forget
};
