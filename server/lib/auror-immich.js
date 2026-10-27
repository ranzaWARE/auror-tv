/*
 * lib/auror-immich.js - Immich's albums on AUROR's Glasshouse Home: its
 * tile in the Apps row opens them, an album's photos and videos as a grid,
 * and each one full screen.
 *
 * Linked from a phone as Jellyfin is: the server's address and an API key of
 * the owner's, which needs album.read, asset.read and asset.view, kept in
 * immich.json readable by root only. The view never has the key: pictures
 * and videos come through here, which adds it.
 *
 * Also on Home: the Top Shelf's memories of this day in years past, from
 * Immich's own, which the key needs memory.read for; without it the tile
 * shows its name. And the photos the AUROR · Immich screen saver goes
 * through (assets/screensavers/auror-immich): an album's, or the library's at
 * random, chosen in Home's settings and kept with the key.
 *
 * An album's contents: Immich 1 listed them with the album; later releases
 * give them a month at a time through the timeline, asked when the album
 * comes without them. The older timeline needed size=MONTH, sent again when
 * the newer one is refused.
 *
 * Strict ES5: runs on node 0.12.
 */
var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');
var crypto = require('crypto');
var parseUrl = require('url').parse;
var util = require('./util');
var msg = require('./say').msg;

var CONFIG_FILE = 'immich.json';
var REQUEST_MS = 8000;
var MAX_JSON = 16 * 1024 * 1024;
var ALBUMS_TTL_MS = 60000;
var ALBUM_TTL_MS = 5 * 60000;
var ALBUMS_KEPT = 20;
var MAX_ASSETS = 20000;
var CODE_TTL_MS = 10 * 60000;
var UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var SIZES = ['thumbnail', 'preview'];
var MEMORIES_TTL_MS = 30 * 60000;
var SAVER_TTL_MS = 60 * 60000;
var SAVER_PHOTOS = 200;

var stateDir = '/var/lib/tvweb';
var nowMs = Date.now;
var cfg = null;
var codes = {};
var albumsCache = null;
var albumCache = {};
var memoriesCache = null;
var saverCache = null;

function init(dir, now) {
  stateDir = dir;
  nowMs = now || Date.now;
  cfg = null;
  codes = {};
  albumsCache = null;
  albumCache = {};
  memoriesCache = null;
  saverCache = null;
}

function file() { return path.join(stateDir, CONFIG_FILE); }

function config() {
  if (cfg) return cfg.server ? cfg : null;
  cfg = {};
  try {
    var raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (raw && typeof raw.server === 'string' && typeof raw.key === 'string') {
      cfg = { server: raw.server, key: raw.key, user: String(raw.user || ''),
        saverAlbum: typeof raw.saverAlbum === 'string' && UUID.test(raw.saverAlbum) ? raw.saverAlbum : null };
    }
  } catch (e) {}
  return cfg.server ? cfg : null;
}

// As typed: http:// assumed, no trailing slash or /api, which the requests add.
function normaliseServer(s) {
  s = String(s || '').trim().replace(/\/+$/, '').replace(/\/api$/i, '');
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  var u = parseUrl(s);
  if (!u.hostname || (u.protocol !== 'http:' && u.protocol !== 'https:')) return null;
  return s;
}

/*
 * A GET to Immich's API, or with headers.body a POST of it as JSON.
 * cb(err, status, body): body is the parsed JSON, or with raw the response
 * itself, still to be read. Other headers go along (Range).
 */
function request(server, key, pathAndQuery, raw, headers, cb) {
  var u = parseUrl(server + '/api' + pathAndQuery);
  var lib = u.protocol === 'https:' ? https : http;
  var h = { 'x-api-key': key, 'Accept': raw ? '*/*' : 'application/json' };
  var payload = null;
  for (var k in headers || {}) if (headers[k] && k !== 'body') h[k] = headers[k];
  if (headers && headers.body) {
    payload = new Buffer(JSON.stringify(headers.body));
    h['Content-Type'] = 'application/json';
    h['Content-Length'] = payload.length;
  }
  var done = false;
  function finish(err, status, body) { if (!done) { done = true; cb(err, status, body); } }
  var req = lib.request({
    hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.path, method: payload ? 'POST' : 'GET', headers: h
  }, function (res) {
    if (raw) return finish(null, res.statusCode, res);
    var chunks = [], size = 0;
    res.on('data', function (d) {
      size += d.length;
      if (size > MAX_JSON) { req.abort(); return finish(new Error('reply too large')); }
      chunks.push(d);
    });
    res.on('end', function () {
      var body = null;
      try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) {}
      finish(null, res.statusCode, body);
    });
  });
  // A video's reply is read for as long as it plays: only the wait for its start is timed.
  req.setTimeout(REQUEST_MS, function () { if (!done) { req.abort(); finish(new Error('timed out')); } });
  req.on('error', function (e) { finish(e); });
  req.end(payload || undefined);
}

function api(pathAndQuery, cb, post) {
  var c = config();
  if (!c) return cb(msg('srv.immich.none', 'Immich is not linked'));
  request(c.server, c.key, pathAndQuery, false, post ? { body: post } : null, function (err, status, body) {
    if (err) return cb(msg('srv.immich.unreachable', 'Immich did not answer: {error}', { error: err.message }));
    if (status === 401 || status === 403) return cb(msg('srv.immich.refused', 'Immich refused the API key: it needs album.read, asset.read and asset.view'), status);
    if (status !== 200) return cb(msg('srv.immich.status', 'Immich answered {status}', { status: status }), status);
    cb(null, status, body);
  });
}

function isList(x) { return Object.prototype.toString.call(x) === '[object Array]'; }
function day(s) { return typeof s === 'string' && /^\d{4}-\d\d-\d\d/.test(s) ? s.slice(0, 10) : null; }

// ------------------------------------------------------------- albums

// Every album the key can read, owned or shared, the one added to last first.
function albums(cb) {
  if (albumsCache && nowMs() - albumsCache.at < ALBUMS_TTL_MS) return cb(albumsCache.value);
  api('/albums', function (error, status, body) {
    if (error) return cb({ ok: false, error: error });
    var list = (isList(body) ? body : []).filter(function (a) { return a && typeof a.id === 'string' && UUID.test(a.id); })
      .map(function (a) {
        return { id: a.id, name: String(a.albumName || ''), count: +a.assetCount || 0,
          cover: UUID.test(String(a.albumThumbnailAssetId || '')) ? a.albumThumbnailAssetId : null,
          from: day(a.startDate), to: day(a.endDate), shared: a.shared === true,
          at: String(a.lastModifiedAssetTimestamp || a.endDate || a.updatedAt || '') };
      });
    list.sort(function (x, y) { return x.at < y.at ? 1 : x.at > y.at ? -1 : 0; });
    var value = { ok: true, albums: list.map(function (a) { delete a.at; return a; }) };
    albumsCache = { at: nowMs(), value: value };
    cb(value);
  });
}

function asset(id, video, date, place) {
  return { id: id, video: !!video, date: day(date), place: place || null };
}

/*
 * One album: its name and what is in it, in the album's own order (newest
 * first unless set otherwise), each { id, video, date, place }.
 */
function album(id, cb) {
  if (typeof id !== 'string' || !UUID.test(id)) return cb({ ok: false, error: msg('srv.immich.noAlbum', 'that album is not on Immich') });
  var kept = albumCache[id];
  if (kept && nowMs() - kept.at < ALBUM_TTL_MS) return cb(kept.value);
  api('/albums/' + id, function (error, status, info) {
    if (error) return cb({ ok: false, error: status === 404 || status === 400 ? msg('srv.immich.noAlbum', 'that album is not on Immich') : error });
    var order = info && info.order === 'asc' ? 'asc' : 'desc';
    function answer(assets) {
      var value = { ok: true, id: id, name: String((info && info.albumName) || ''), count: assets.length, assets: assets.slice(0, MAX_ASSETS) };
      var ids = Object.keys(albumCache);
      if (ids.length >= ALBUMS_KEPT) delete albumCache[ids[0]];
      albumCache[id] = { at: nowMs(), value: value };
      cb(value);
    }
    if (info && isList(info.assets)) {
      var listed = info.assets.filter(function (a) { return a && UUID.test(String(a.id)); }).map(function (a) {
        var ex = a.exifInfo || {};
        return asset(a.id, a.type === 'VIDEO', a.localDateTime || a.fileCreatedAt, ex.city || ex.country);
      });
      listed.sort(function (x, y) { return (x.date || '') < (y.date || '') ? (order === 'asc' ? -1 : 1) : (x.date || '') > (y.date || '') ? (order === 'asc' ? 1 : -1) : 0; });
      return answer(listed);
    }
    timeline(id, order, function (err, assets) {
      if (err) return cb({ ok: false, error: err });
      answer(assets);
    });
  });
}

function timeline(id, order, cb) {
  var base = '?albumId=' + id + '&order=' + order;
  api('/timeline/buckets' + base, function (error, status, buckets) {
    if (error && status === 400) {
      // Immich 1's timeline: the same, by month.
      base += '&size=MONTH';
      return api('/timeline/buckets' + base, listed);
    }
    listed(error, status, buckets);
  });
  function listed(error, status, buckets) {
    if (error) return cb(error);
    var months = (isList(buckets) ? buckets : []).map(function (b) { return b && b.timeBucket; })
      .filter(function (b) { return typeof b === 'string' && /^[0-9TZ:.+-]{4,40}$/.test(b); });
    var out = [];
    (function next(i) {
      if (i >= months.length || out.length >= MAX_ASSETS) return cb(null, out);
      api('/timeline/bucket' + base + '&timeBucket=' + encodeURIComponent(months[i]), function (err, st, b) {
        if (err) return cb(err);
        if (isList(b)) {
          b.forEach(function (a) {
            if (a && UUID.test(String(a.id))) out.push(asset(a.id, a.type === 'VIDEO', a.localDateTime || a.fileCreatedAt, a.exifInfo && (a.exifInfo.city || a.exifInfo.country)));
          });
        } else if (b && isList(b.id)) {
          // Columns: id[i], isImage[i] and the rest for the same asset.
          b.id.forEach(function (aid, j) {
            if (!UUID.test(String(aid))) return;
            var place = (b.city && b.city[j]) || (b.country && b.country[j]) || null;
            out.push(asset(aid, b.isImage && b.isImage[j] === false, (b.localDateTime && b.localDateTime[j]) || (b.fileCreatedAt && b.fileCreatedAt[j]), place));
          });
        }
        next(i + 1);
      });
    })(0);
  }
}

// ------------------------------------------------------------- memories

function today() {
  var d = new Date(nowMs());
  function two(n) { return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + '-' + two(d.getMonth() + 1) + '-' + two(d.getDate());
}

function placeOf(a) {
  var ex = (a && a.exifInfo) || {};
  return ex.city || ex.country || null;
}

/*
 * This day in years past, as Immich keeps it: { year, count, cover, place }
 * each, the most recent year first, the photos only. day is the view's own
 * date, so the TV's time zone counts. Without memory.read, or on an Immich
 * without memories, there are none.
 */
function memories(day, cb) {
  if (!config()) return cb({ ok: false, error: msg('srv.immich.none', 'Immich is not linked') });
  day = /^\d{4}-\d\d-\d\d$/.test(String(day || '')) ? day : today();
  if (memoriesCache && memoriesCache.day === day && nowMs() - memoriesCache.at < MEMORIES_TTL_MS) return cb(memoriesCache.value);
  api('/memories?for=' + day + '&type=on_this_day', function (error, status, list) {
    var out = [];
    (isList(list) ? list : []).forEach(function (m) {
      var all = m && isList(m.assets) ? m.assets : [];
      var photos = all.filter(function (a) { return a && UUID.test(String(a.id)) && a.type !== 'VIDEO'; });
      var year = m && m.data && +m.data.year;
      if (!photos.length || !year) return;
      var placed = photos.filter(placeOf)[0];
      out.push({ year: year, count: all.length, cover: photos[0].id, place: placed ? placeOf(placed) : null });
    });
    out.sort(function (x, y) { return y.year - x.year; });
    var value = { ok: true, day: day, memories: out, unavailable: !!error };
    memoriesCache = { at: nowMs(), day: day, value: value };
    cb(value);
  });
}

// ------------------------------------------------------------- the screen saver's photos

function shuffle(list) {
  for (var i = list.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1)), x = list[i];
    list[i] = list[j];
    list[j] = x;
  }
  return list;
}

/*
 * The photos the AUROR · Immich screen saver shows, { id, date, place } each,
 * in a new order each hour: the chosen album's, or else a random draw from
 * the library. Videos are left out.
 */
function saverPhotos(cb) {
  var c = config();
  if (!c) return cb({ ok: false, error: msg('srv.immich.none', 'Immich is not linked'), items: [] });
  if (saverCache && saverCache.album === c.saverAlbum && nowMs() - saverCache.at < SAVER_TTL_MS) return cb(saverCache.value);
  function done(items, error) {
    var value = { ok: !error, error: error || undefined, album: c.saverAlbum, items: shuffle(items).slice(0, SAVER_PHOTOS) };
    if (!error) saverCache = { at: nowMs(), album: c.saverAlbum, value: value };
    cb(value);
  }
  if (c.saverAlbum) {
    return album(c.saverAlbum, function (r) {
      if (!r.ok) return done([], r.error);
      done(r.assets.filter(function (a) { return !a.video; }).map(function (a) { return { id: a.id, date: a.date, place: a.place }; }));
    });
  }
  api('/search/random', function (error, status, list) {
    if (error) return done([], error);
    done((isList(list) ? list : []).filter(function (a) { return a && UUID.test(String(a.id)) && a.type !== 'VIDEO'; })
      .map(function (a) { return { id: a.id, date: day(a.localDateTime || a.fileCreatedAt), place: placeOf(a) }; }));
  }, { size: SAVER_PHOTOS, type: 'IMAGE', withExif: true });
}

// The album the screen saver shows, or null for the library at random.
function setSaverAlbum(id, cb) {
  var c = config();
  if (!c) return cb({ ok: false, error: msg('srv.immich.none', 'Immich is not linked') });
  if (id !== null && !(typeof id === 'string' && UUID.test(id))) return cb({ ok: false, error: msg('srv.immich.noAlbum', 'that album is not on Immich') });
  try {
    util.writeJsonAtomic(file(), { server: c.server, key: c.key, user: c.user, saverAlbum: id }, 384);
  } catch (e) {
    return cb({ ok: false, error: msg('srv.immich.saveFailed', 'could not save the Immich details') });
  }
  cfg = null;
  saverCache = null;
  cb(status());
}

// ------------------------------------------------------------- pictures and videos

function refuse(res, code) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end('{"ok":false}');
}

// A picture to res: thumbnail for the grids, preview (1440 px) full screen.
function thumb(query, res) {
  var c = config(), id = String(query.id || ''), size = String(query.size || 'thumbnail');
  if (!c || !UUID.test(id) || SIZES.indexOf(size) === -1) return refuse(res, 404);
  request(c.server, c.key, '/assets/' + id + '/thumbnail?size=' + size, true, null, function (err, status, upstream) {
    if (err || status !== 200) {
      if (upstream) upstream.resume();
      return refuse(res, 502);
    }
    res.writeHead(200, {
      'Content-Type': /^image\//.test(upstream.headers['content-type'] || '') ? upstream.headers['content-type'] : 'image/jpeg',
      'Cache-Control': 'private, max-age=86400'
    });
    upstream.pipe(res);
  });
}

// A video to res, as Immich plays it, with the TV's player's ranges passed on.
function video(query, req, res) {
  var c = config(), id = String(query.id || '');
  if (!c || !UUID.test(id)) return refuse(res, 404);
  var range = req.headers && req.headers.range;
  request(c.server, c.key, '/assets/' + id + '/video/playback', true, { Range: /^bytes=[0-9,\s-]+$/.test(String(range || '')) ? range : null },
    function (err, status, upstream) {
      if (err || (status !== 200 && status !== 206)) {
        if (upstream) upstream.resume();
        return refuse(res, 502);
      }
      var h = { 'Content-Type': /^video\//.test(upstream.headers['content-type'] || '') ? upstream.headers['content-type'] : 'video/mp4',
        'Accept-Ranges': 'bytes', 'Cache-Control': 'private, no-store' };
      ['content-length', 'content-range'].forEach(function (k) {
        if (upstream.headers[k]) h[k.replace(/(^|-)(\w)/g, function (m, d, ch) { return d + ch.toUpperCase(); })] = upstream.headers[k];
      });
      res.writeHead(status, h);
      upstream.pipe(res);
      res.on('close', function () { upstream.destroy(); });
    });
}

// ------------------------------------------------------------- linking from a phone

function status() {
  var c = config();
  if (!c) return { ok: true, configured: false };
  return { ok: true, configured: true, server: parseUrl(c.server).host, user: c.user, saverAlbum: c.saverAlbum };
}

function pair(origin) {
  if (!origin) return { ok: false, error: msg('srv.home.jfNoNetwork', 'the TV has no address a phone can reach') };
  var now = nowMs();
  for (var k in codes) if (codes[k] < now) delete codes[k];
  var code = crypto.randomBytes(8).toString('hex');
  codes[code] = now + CODE_TTL_MS;
  return { ok: true, url: origin + '/immich?c=' + code, expiresIn: CODE_TTL_MS };
}

function codeValid(code) {
  return typeof code === 'string' && codes.hasOwnProperty(code) && codes[code] >= nowMs();
}

/*
 * From the phone: { c, server, key }, or { c, check: true } as its page
 * opens. The key is tried on the albums before it is kept; the user's name,
 * where the key may read it, is for the settings.
 */
function link(body, cb) {
  if (!body || !codeValid(body.c)) return cb({ ok: false, expired: true, error: msg('srv.immich.expired', 'This code has expired. Open Immich in the TV\'s Home settings for a new one.') });
  if (body.check === true) return cb({ ok: true, valid: true });
  var server = normaliseServer(body.server);
  var key = String(body.key || '').trim();
  if (!server) return cb({ ok: false, error: msg('srv.home.jfServer', 'the server address is not valid') });
  if (!/^[A-Za-z0-9_\-+=\/.]{16,128}$/.test(key)) return cb({ ok: false, error: msg('srv.immich.key', 'that is not an Immich API key: make one in Immich, Account settings, API keys') });
  request(server, key, '/albums', false, null, function (err, st, list) {
    if (err) return cb({ ok: false, error: msg('srv.immich.unreachable', 'Immich did not answer: {error}', { error: err.message }) });
    if (st === 401 || st === 403) return cb({ ok: false, error: msg('srv.immich.refused', 'Immich refused the API key: it needs album.read, asset.read and asset.view') });
    if (st !== 200 || !isList(list)) return cb({ ok: false, error: msg('srv.immich.notImmich', 'that address did not answer as an Immich server; its port is usually 2283') });
    request(server, key, '/users/me', false, null, function (e2, st2, me) {
      var user = !e2 && st2 === 200 && me && typeof me.name === 'string' ? me.name : '';
      try {
        util.writeJsonAtomic(file(), { server: server, key: key, user: user }, 384);
      } catch (e) {
        return cb({ ok: false, error: msg('srv.immich.saveFailed', 'could not save the Immich details') });
      }
      delete codes[body.c];
      cfg = null;
      albumsCache = null;
      albumCache = {};
      memoriesCache = null;
      saverCache = null;
      console.log('immich: linked from a phone' + (user ? ', user ' + user : '') + ', ' + list.length + ' albums');
      cb({ ok: true, user: user, albums: list.length });
    });
  });
}

function forget(cb) {
  util.unlinkQuiet(file());
  cfg = null;
  albumsCache = null;
  albumCache = {};
  memoriesCache = null;
  saverCache = null;
  cb({ ok: true, configured: false });
}

module.exports = {
  init: init,
  albums: albums,
  album: album,
  memories: memories,
  saverPhotos: saverPhotos,
  setSaverAlbum: setSaverAlbum,
  thumb: thumb,
  video: video,
  status: status,
  pair: pair,
  codeValid: codeValid,
  link: link,
  forget: forget
};
