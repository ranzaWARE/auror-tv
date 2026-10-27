/* Jellyfin for Glasshouse Home's Top Shelf: what is being watched, or else
 * what was added last, from the owner's own server. Linked from a phone with
 * a one-time code shown as a QR code on the TV, so the API key is never typed
 * with the remote; it is kept in jellyfin.json (0600) and never sent back.
 * Strict ES5 for the TV's Node 0.10/0.12. */
var fs = require('fs');
var path = require('path');
var http = require('http');
var https = require('https');
var crypto = require('crypto');
var parseUrl = require('url').parse;
var util = require('./util');
var msg = require('./say').msg;

var CONFIG_FILE = 'jellyfin.json';
var REQUEST_MS = 4000;
var SHELF_TTL_MS = 60000;
var CODE_TTL_MS = 10 * 60000;
var SHELF_ITEMS = 3;
var SEARCH_ITEMS = 8;
var IMAGE_WIDTH = 480;
var MAX_JSON = 2 * 1024 * 1024;
var AUTH = 'MediaBrowser Client="Glasshouse", Device="LG TV", DeviceId="glasshouse-home", Version="1"';

var stateDir = '/var/lib/tvweb';
var nowMs = Date.now;
var cfg = null;
var shelfCache = null;
var shelfWaiting = null;
var codes = {};

function init(dir, now) {
  stateDir = dir;
  nowMs = now || Date.now;
  cfg = null;
  shelfCache = null;
  shelfWaiting = null;
  codes = {};
}

function file() { return path.join(stateDir, CONFIG_FILE); }

function config() {
  if (cfg) return cfg.server ? cfg : null;
  cfg = {};
  try {
    var raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (raw && typeof raw.server === 'string' && typeof raw.key === 'string' && typeof raw.userId === 'string') {
      cfg = { server: raw.server, key: raw.key, userId: raw.userId, userName: String(raw.userName || '') };
    }
  } catch (e) {}
  return cfg.server ? cfg : null;
}

// The server's address as typed, made a base URL: http:// assumed, no trailing slash.
function normaliseServer(s) {
  s = String(s || '').trim().replace(/\/+$/, '');
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  var u = parseUrl(s);
  if (!u.hostname || (u.protocol !== 'http:' && u.protocol !== 'https:')) return null;
  return s;
}

/*
 * A GET to the server. cb(err, status, body): body is the parsed JSON, or with
 * raw the response itself, still to be read.
 */
function request(server, key, pathAndQuery, raw, cb) {
  var u = parseUrl(server + pathAndQuery);
  var lib = u.protocol === 'https:' ? https : http;
  var done = false;
  function finish(err, status, body) { if (!done) { done = true; cb(err, status, body); } }
  var req = lib.request({
    hostname: u.hostname, port: u.port || (u.protocol === 'https:' ? 443 : 80), path: u.path, method: 'GET',
    headers: { 'Authorization': AUTH + ', Token="' + key + '"', 'Accept': raw ? '*/*' : 'application/json' }
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
  req.setTimeout(REQUEST_MS, function () { req.abort(); finish(new Error('timed out')); });
  req.on('error', function (e) { finish(e); });
  req.end();
}

/*
 * Jellyfin 10.9 moved the per-user lists from /Users/{id}/Items/... to
 * /UserItems/... and /Items/Latest with ?userId=; the old paths are kept as
 * obsolete. The new one is asked first, the old one on a 404.
 */
function userList(c, kind, cb) {
  var q = 'limit=' + SHELF_ITEMS + '&fields=PrimaryImageAspectRatio&enableImageTypes=Primary,Backdrop,Thumb&imageTypeLimit=1';
  var uid = encodeURIComponent(c.userId);
  var now = kind === 'resume' ? '/UserItems/Resume?mediaTypes=Video&userId=' + uid + '&' + q
    : '/Items/Latest?includeItemTypes=Movie,Episode,Series&userId=' + uid + '&' + q;
  var old = kind === 'resume' ? '/Users/' + uid + '/Items/Resume?MediaTypes=Video&' + q
    : '/Users/' + uid + '/Items/Latest?IncludeItemTypes=Movie,Episode,Series&' + q;
  request(c.server, c.key, now, false, function (err, status, body) {
    if (!err && status === 404) return request(c.server, c.key, old, false, listed);
    listed(err, status, body);
  });
  function listed(err, status, body) {
    if (err || status !== 200 || !body) return cb(null);
    // Resume answers { Items: [...] }, Latest a bare list.
    var items = Object.prototype.toString.call(body) === '[object Array]' ? body : body.Items;
    cb(Object.prototype.toString.call(items) === '[object Array]' ? items : []);
  }
}

// A 16:9 picture for the card: an episode's own still, else a thumb or backdrop.
function picture(it) {
  var tags = it.ImageTags || {};
  if (it.Type === 'Episode' && tags.Primary) return { id: it.Id, type: 'Primary', tag: tags.Primary };
  if (tags.Thumb) return { id: it.Id, type: 'Thumb', tag: tags.Thumb };
  if (it.BackdropImageTags && it.BackdropImageTags.length) return { id: it.Id, type: 'Backdrop', tag: it.BackdropImageTags[0] };
  if (it.ParentThumbItemId && it.ParentThumbImageTag) return { id: it.ParentThumbItemId, type: 'Thumb', tag: it.ParentThumbImageTag };
  if (it.ParentBackdropItemId && it.ParentBackdropImageTags && it.ParentBackdropImageTags.length) {
    return { id: it.ParentBackdropItemId, type: 'Backdrop', tag: it.ParentBackdropImageTags[0] };
  }
  if (tags.Primary) return { id: it.Id, type: 'Primary', tag: tags.Primary };
  return null;
}

function card(it) {
  var episode = it.Type === 'Episode';
  var pic = picture(it);
  var played = it.UserData && typeof it.UserData.PlayedPercentage === 'number' ? it.UserData.PlayedPercentage : null;
  return {
    title: String((episode && it.SeriesName) || it.Name || ''),
    // The view words the line under the title: season and episode, or the kind.
    kind: episode ? 'episode' : it.Type === 'Series' ? 'series' : 'movie',
    season: episode && typeof it.ParentIndexNumber === 'number' ? it.ParentIndexNumber : null,
    episode: episode && typeof it.IndexNumber === 'number' ? it.IndexNumber : null,
    name: episode ? String(it.Name || '') : '',
    year: typeof it.ProductionYear === 'number' ? it.ProductionYear : null,
    progress: played === null ? null : Math.max(0, Math.min(100, Math.round(played))),
    image: pic ? '/api/home/jellyfin/image?id=' + encodeURIComponent(pic.id) + '&type=' + pic.type + '&tag=' + encodeURIComponent(pic.tag) : null
  };
}

/*
 * What the Top Shelf shows: { state: 'off' | 'offline' | 'resume' | 'latest' | 'empty', items }.
 * Kept a minute, so moving along the row and back does not ask again.
 */
function shelf(cb) {
  var c = config();
  if (!c) return cb({ ok: true, state: 'off', items: [] });
  if (shelfCache && nowMs() - shelfCache.at < SHELF_TTL_MS) return cb(shelfCache.value);
  if (shelfWaiting) return shelfWaiting.push(cb);
  shelfWaiting = [cb];
  function answer(value) {
    shelfCache = { at: nowMs(), value: value };
    var waiting = shelfWaiting;
    shelfWaiting = null;
    waiting.forEach(function (w) { w(value); });
  }
  userList(c, 'resume', function (resume) {
    if (resume === null) return answer({ ok: true, state: 'offline', items: [] });
    if (resume.length) return answer({ ok: true, state: 'resume', items: resume.map(card) });
    userList(c, 'latest', function (latest) {
      if (latest === null) return answer({ ok: true, state: 'offline', items: [] });
      answer({ ok: true, state: latest.length ? 'latest' : 'empty', items: latest.map(card) });
    });
  });
}

/*
 * Films and series in the library whose names match, for the search
 * (lib/auror-search): { title, kind: 'film'|'series', year, minutes, genre,
 * tmdb, image }, or null with no server or no answer. Asked at /Items with
 * ?userId= as 10.9 has it, and at /Users/{id}/Items on a 404.
 */
function search(words, cb) {
  var c = config();
  if (!c) return cb(null);
  var uid = encodeURIComponent(c.userId);
  var q = 'searchTerm=' + encodeURIComponent(words) + '&includeItemTypes=Movie,Series&recursive=true&limit=' + SEARCH_ITEMS +
    '&fields=ProductionYear,Genres,ProviderIds&enableImageTypes=Primary,Backdrop,Thumb&imageTypeLimit=1';
  request(c.server, c.key, '/Items?userId=' + uid + '&' + q, false, function (err, status, body) {
    if (!err && status === 404) return request(c.server, c.key, '/Users/' + uid + '/Items?' + q, false, found);
    found(err, status, body);
  });
  function found(err, status, body) {
    if (err || status !== 200 || !body || Object.prototype.toString.call(body.Items) !== '[object Array]') return cb(null);
    cb(body.Items.filter(function (it) { return it && it.Id && it.Name; }).map(function (it) {
      var pic = picture(it), ids = it.ProviderIds || {};
      return {
        title: String(it.Name),
        kind: it.Type === 'Series' ? 'series' : 'film',
        year: typeof it.ProductionYear === 'number' ? it.ProductionYear : null,
        minutes: typeof it.RunTimeTicks === 'number' ? Math.round(it.RunTimeTicks / 600000000) || null : null,
        genre: Object.prototype.toString.call(it.Genres) === '[object Array]' ? it.Genres.slice(0, 3).join(', ') : null,
        tmdb: ids.Tmdb || ids.tmdb || null,
        image: pic ? '/api/home/jellyfin/image?id=' + encodeURIComponent(pic.id) + '&type=' + pic.type + '&tag=' + encodeURIComponent(pic.tag) : null
      };
    }));
  }
}

// Streams one picture to res, from the server, with the key added here.
function image(query, res) {
  var c = config();
  var id = String(query.id || ''), type = String(query.type || ''), tag = String(query.tag || '');
  if (!c || !/^[0-9a-f]{32}$/i.test(id) || ['Primary', 'Thumb', 'Backdrop'].indexOf(type) === -1 || !/^[0-9a-z]{1,64}$/i.test(tag)) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    return res.end('{"ok":false}');
  }
  request(c.server, c.key, '/Items/' + id + '/Images/' + type + '?maxWidth=' + IMAGE_WIDTH + '&quality=85&tag=' + tag, true,
    function (err, status, upstream) {
      if (err || status !== 200) {
        if (upstream) upstream.resume();
        res.writeHead(502, { 'Content-Type': 'application/json' });
        return res.end('{"ok":false}');
      }
      res.writeHead(200, {
        'Content-Type': /^image\//.test(upstream.headers['content-type'] || '') ? upstream.headers['content-type'] : 'image/jpeg',
        // The tag changes with the picture.
        'Cache-Control': 'private, max-age=86400'
      });
      upstream.pipe(res);
    });
}

function status() {
  var c = config();
  if (!c) return { ok: true, configured: false };
  var u = parseUrl(c.server);
  return { ok: true, configured: true, server: u.host, user: c.userName };
}

/*
 * A one-time code for the phone, as a link to the page that takes the details.
 * origin is the address a phone on the network reaches this server at.
 */
function pair(origin) {
  if (!origin) return { ok: false, error: msg('srv.home.jfNoNetwork', 'the TV has no address a phone can reach') };
  var now = nowMs();
  for (var k in codes) if (codes[k] < now) delete codes[k];
  var code = crypto.randomBytes(8).toString('hex');
  codes[code] = now + CODE_TTL_MS;
  return { ok: true, url: origin + '/jellyfin?c=' + code, expiresIn: CODE_TTL_MS };
}

function codeValid(code) {
  return typeof code === 'string' && codes.hasOwnProperty(code) && codes[code] >= nowMs();
}

/*
 * From the phone: { c, server, key, user }, or { c, check: true } as its page
 * opens. The details are tried before they are kept. With more than one user
 * and none named, the reply lists them for the phone to offer.
 */
function link(body, cb) {
  if (!body || !codeValid(body.c)) return cb({ ok: false, expired: true, error: msg('srv.home.jfExpired', 'This code has expired. Open Jellyfin in the TV\'s Home settings for a new one.') });
  // The page asks first whether its code is still good.
  if (body.check === true) return cb({ ok: true, valid: true });
  var server = normaliseServer(body.server);
  var key = String(body.key || '').trim();
  if (!server) return cb({ ok: false, error: msg('srv.home.jfServer', 'the server address is not valid') });
  if (!/^[0-9a-f]{32}$/i.test(key)) return cb({ ok: false, error: msg('srv.home.jfKey', 'an API key is 32 letters and digits, from Jellyfin\'s Dashboard, API Keys') });
  request(server, key, '/Users', false, function (err, st, users) {
    if (err) return cb({ ok: false, error: msg('srv.home.jfUnreachable', 'the server did not answer: {error}', { error: err.message }) });
    if (st === 401 || st === 403) return cb({ ok: false, error: msg('srv.home.jfRefused', 'the server refused the API key') });
    if (st !== 200 || Object.prototype.toString.call(users) !== '[object Array]') {
      return cb({ ok: false, error: msg('srv.home.jfNotJellyfin', 'that address did not answer as a Jellyfin server') });
    }
    var list = users.filter(function (u) { return u && typeof u.Id === 'string'; })
      .map(function (u) { return { id: u.Id, name: String(u.Name || u.Id) }; });
    var wanted = String(body.user || '');
    var hit = null;
    list.forEach(function (u) { if (u.id === wanted || u.name.toLowerCase() === wanted.toLowerCase()) hit = u; });
    if (!hit && list.length === 1) hit = list[0];
    if (!hit) return cb({ ok: false, needUser: true, users: list });
    try {
      util.writeJsonAtomic(file(), { server: server, key: key, userId: hit.id, userName: hit.name }, 384);
    } catch (e) {
      return cb({ ok: false, error: msg('srv.home.jfSaveFailed', 'could not save the Jellyfin details') });
    }
    delete codes[body.c];
    cfg = null;
    shelfCache = null;
    console.log('home: Jellyfin linked from a phone, user ' + hit.name);
    cb({ ok: true, user: hit.name });
  });
}

function forget(cb) {
  util.unlinkQuiet(file());
  cfg = null;
  shelfCache = null;
  cb({ ok: true, configured: false });
}

module.exports = {
  init: init,
  shelf: shelf,
  search: search,
  image: image,
  status: status,
  pair: pair,
  codeValid: codeValid,
  link: link,
  forget: forget
};
