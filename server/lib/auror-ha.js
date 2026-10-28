/*
 * lib/auror-ha.js - Home Assistant on AUROR's Glasshouse Home: its tile in the
 * Apps row opens a panel of the entities chosen for the TV, as AUROR's own
 * tiles: lights and switches turned on and off, heating and air conditioning
 * set, covers opened and closed, scenes and scripts run, sensors read and
 * cameras watched. The tile can also open Home Assistant's own dashboard in
 * the TV's browser.
 *
 * This is the other way round from lib/ha, which puts the TV into Home
 * Assistant over MQTT: here the TV asks Home Assistant, over its REST API,
 * with a long-lived access token of the owner's. Address and token are
 * linked from a phone, as Jellyfin's are, and kept in auror-ha.json readable
 * by root only, with the entities chosen on the same page. The view never
 * has the token, and only the entities chosen can be acted on, with the
 * services each kind has here and no others.
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

var CONFIG_FILE = 'auror-ha.json';
var REQUEST_MS = 8000;
var MAX_JSON = 16 * 1024 * 1024;
var STATES_TTL_MS = 2000;
var CODE_IDLE_MS = 30 * 60000;
var MAX_CHOSEN = 80;
var ENTITY = /^[a-z_]+\.[a-z0-9_]{1,200}$/;

/*
 * The kinds of entity the panel shows, in its order, each with the domains it
 * takes. Locks and alarms are left out: not something to open from a remote.
 */
var GROUPS = [
  { id: 'climate', domains: ['climate'] },
  { id: 'power', domains: ['light', 'switch', 'input_boolean', 'fan'] },
  { id: 'covers', domains: ['cover'] },
  { id: 'scenes', domains: ['scene', 'script'] },
  { id: 'sensors', domains: ['sensor', 'binary_sensor'] },
  { id: 'cameras', domains: ['camera'] }
];
// What each panel tile may ask for, as Home Assistant's services.
var ACTIONS = {
  toggle: ['light', 'switch', 'input_boolean', 'fan', 'cover'],
  run: ['scene', 'script'],
  temperature: ['climate'],
  mode: ['climate'],
  open: ['cover'],
  close: ['cover'],
  stop: ['cover']
};
// Picked to start with, before anything is chosen: few enough to read.
var SUGGESTED = { climate: true, light: true, cover: true, scene: true, camera: true };
var SENSOR_CLASSES = { temperature: true, humidity: true, power: true, energy: true, pm25: true, carbon_dioxide: true };

var stateDir = '/var/lib/tvweb';
var nowMs = Date.now;
var control = null;
var cfg = null;
var codes = {};
var statesCache = null;

/**
 * @param {Object} opts
 * @param {string} opts.stateDir
 * @param {function(string, any, function(Object): void): void} [opts.control] doControl, for launchUrl
 * @param {function(): number} [opts.now] for tests
 */
function init(opts) {
  stateDir = opts.stateDir;
  control = opts.control || null;
  nowMs = opts.now || Date.now;
  cfg = null;
  codes = {};
  statesCache = null;
}

function file() { return path.join(stateDir, CONFIG_FILE); }

function config() {
  if (cfg) return cfg.server ? cfg : null;
  cfg = {};
  try {
    var raw = JSON.parse(fs.readFileSync(file(), 'utf8'));
    if (raw && typeof raw.server === 'string' && typeof raw.token === 'string') {
      cfg = { server: raw.server, token: raw.token, place: String(raw.place || ''),
        chosen: Object.prototype.toString.call(raw.chosen) === '[object Array]'
          ? raw.chosen.filter(function (id) { return typeof id === 'string' && ENTITY.test(id); }).slice(0, MAX_CHOSEN) : null };
    }
  } catch (e) {}
  return cfg.server ? cfg : null;
}

function save(next) {
  util.writeJsonAtomic(file(), next, 384);
  cfg = null;
  statesCache = null;
}

// As typed: http:// assumed, port 8123 when none is given, no trailing slash.
function normaliseServer(s) {
  s = String(s || '').trim().replace(/\/+$/, '').replace(/\/(api|lovelace)(\/.*)?$/i, '');
  if (!s) return null;
  if (!/^https?:\/\//i.test(s)) s = 'http://' + s;
  var u = parseUrl(s);
  if (!u.hostname || (u.protocol !== 'http:' && u.protocol !== 'https:')) return null;
  if (!u.port && u.protocol === 'http:') s = u.protocol + '//' + u.hostname + ':8123';
  return s;
}

/*
 * A call to Home Assistant's REST API: GET, or POST with body. cb(err,
 * status, body): body parsed, or with raw the response itself.
 */
function request(server, token, pathAndQuery, body, raw, cb) {
  var u = parseUrl(server + pathAndQuery);
  var lib = u.protocol === 'https:' ? https : http;
  var payload = body ? new Buffer(JSON.stringify(body)) : null;
  var h = { 'Authorization': 'Bearer ' + token, 'Accept': raw ? '*/*' : 'application/json' };
  if (payload) { h['Content-Type'] = 'application/json'; h['Content-Length'] = payload.length; }
  var done = false;
  function finish(err, status, b) { if (!done) { done = true; cb(err, status, b); } }
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
      var parsed = null;
      try { parsed = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch (e) {}
      finish(null, res.statusCode, parsed);
    });
  });
  // A camera's stream is read for as long as it is watched: only the wait for its start is timed.
  req.setTimeout(REQUEST_MS, function () { if (!done) { req.abort(); finish(new Error('timed out')); } });
  req.on('error', function (e) { finish(e); });
  req.end(payload || undefined);
}

function api(pathAndQuery, body, cb) {
  var c = config();
  if (!c) return cb(msg('srv.ha.none', 'Home Assistant is not linked'));
  request(c.server, c.token, pathAndQuery, body, false, function (err, status, b) {
    if (err) return cb(msg('srv.ha.unreachable', 'Home Assistant did not answer: {error}', { error: err.message }));
    if (status === 401 || status === 403) return cb(msg('srv.ha.refused', 'Home Assistant refused the token'), status);
    if (status < 200 || status > 299) return cb(msg('srv.ha.status', 'Home Assistant answered {status}', { status: status }), status);
    cb(null, status, b);
  });
}

function isList(x) { return Object.prototype.toString.call(x) === '[object Array]'; }
function domainOf(id) { return id.split('.')[0]; }
function groupOf(id) {
  var d = domainOf(id);
  for (var i = 0; i < GROUPS.length; i++) if (GROUPS[i].domains.indexOf(d) !== -1) return GROUPS[i].id;
  return null;
}

// ------------------------------------------------------------- states

function allStates(cb) {
  if (statesCache && nowMs() - statesCache.at < STATES_TTL_MS) return cb(null, statesCache.list);
  api('/api/states', null, function (error, status, list) {
    if (error) return cb(error);
    var out = (isList(list) ? list : []).filter(function (s) { return s && ENTITY.test(String(s.entity_id)) && groupOf(s.entity_id); });
    statesCache = { at: nowMs(), list: out };
    cb(null, out);
  });
}

function num(v) { return typeof v === 'number' && isFinite(v) ? v : null; }

// What the view needs of one entity, and nothing it does not.
function view(s) {
  var a = s.attributes || {}, d = domainOf(s.entity_id);
  var v = { id: s.entity_id, group: groupOf(s.entity_id), domain: d, name: String(a.friendly_name || s.entity_id), state: String(s.state) };
  if (d === 'climate') {
    v.current = num(a.current_temperature);
    v.target = num(a.temperature);
    v.min = num(a.min_temp);
    v.max = num(a.max_temp);
    v.step = num(a.target_temp_step) || 0.5;
    v.modes = isList(a.hvac_modes) ? a.hvac_modes.filter(function (m) { return typeof m === 'string'; }) : [];
    v.action = typeof a.hvac_action === 'string' ? a.hvac_action : null;
    v.humidity = num(a.current_humidity);
  } else if (d === 'light') {
    v.brightness = num(a.brightness) !== null ? Math.round(a.brightness / 2.55) : null;
  } else if (d === 'cover') {
    v.position = num(a.current_position);
  } else if (d === 'sensor' || d === 'binary_sensor') {
    v.unit = typeof a.unit_of_measurement === 'string' ? a.unit_of_measurement : null;
    v.deviceClass = typeof a.device_class === 'string' ? a.device_class : null;
  }
  return v;
}

/*
 * The entities chosen for the TV, in the panel's order, or with none chosen
 * yet, a first pick: heating, lights, covers, scenes, cameras and the usual
 * readings, at most 40.
 */
function states(cb) {
  var c = config();
  if (!c) return cb({ ok: false, error: msg('srv.ha.none', 'Home Assistant is not linked') });
  allStates(function (error, list) {
    if (error) return cb({ ok: false, error: error });
    var picked = c.chosen
      ? list.filter(function (s) { return c.chosen.indexOf(s.entity_id) !== -1; })
      : list.filter(function (s) {
        var d = domainOf(s.entity_id);
        return SUGGESTED[d] || (d === 'sensor' && SENSOR_CLASSES[(s.attributes || {}).device_class]);
      }).slice(0, 40);
    var order = GROUPS.map(function (g) { return g.id; });
    var out = picked.map(view);
    out.sort(function (x, y) { return order.indexOf(x.group) - order.indexOf(y.group) || (x.name < y.name ? -1 : x.name > y.name ? 1 : 0); });
    cb({ ok: true, place: c.place, chosen: !!c.chosen, entities: out });
  });
}

// ------------------------------------------------------------- acting

/*
 * { id, action, value }: only an entity chosen (or first picked) for the TV,
 * and only what its kind may do here.
 */
function act(body, cb) {
  var id = String(body && body.id || ''), action = String(body && body.action || '');
  if (!ENTITY.test(id) || !ACTIONS[action] || ACTIONS[action].indexOf(domainOf(id)) === -1) {
    return cb({ ok: false, error: msg('srv.ha.notAllowed', 'that is not something the TV can do here') });
  }
  states(function (r) {
    if (!r.ok) return cb(r);
    /** @type {any} */
    var hit = null;
    r.entities.forEach(function (e) { if (e.id === id) hit = e; });
    if (!hit) return cb({ ok: false, error: msg('srv.ha.notChosen', 'that entity is not one chosen for the TV') });
    var d = hit.domain, service, data = { entity_id: id };
    if (action === 'toggle') service = d === 'cover' ? 'cover/toggle' : 'homeassistant/toggle';
    else if (action === 'run') service = d + '/turn_on';
    else if (action === 'open') service = 'cover/open_cover';
    else if (action === 'close') service = 'cover/close_cover';
    else if (action === 'stop') service = 'cover/stop_cover';
    else if (action === 'temperature') {
      var t = Number(body.value);
      if (!isFinite(t) || (hit.min !== null && t < hit.min) || (hit.max !== null && t > hit.max)) {
        return cb({ ok: false, error: msg('srv.ha.range', 'that temperature is out of range') });
      }
      service = 'climate/set_temperature';
      data.temperature = Math.round(t * 10) / 10;
    } else if (action === 'mode') {
      if (hit.modes.indexOf(String(body.value)) === -1) return cb({ ok: false, error: msg('srv.ha.mode', 'that mode is not one this entity has') });
      service = 'climate/set_hvac_mode';
      data.hvac_mode = String(body.value);
    }
    api('/api/services/' + service, data, function (error) {
      if (error) return cb({ ok: false, error: error });
      statesCache = null;
      console.log('auror-ha: ' + service + ' ' + id);
      // Home Assistant takes a moment to report the new state.
      setTimeout(function () { states(cb); }, 400);
    });
  });
}

// ------------------------------------------------------------- cameras

function refuse(res, code) {
  res.writeHead(code, { 'Content-Type': 'application/json' });
  res.end('{"ok":false}');
}

/*
 * A camera to res: a still, or with live, Home Assistant's MJPEG stream,
 * which the TV's browser shows in an img as it comes. Only a chosen camera.
 */
function camera(query, res) {
  var c = config(), id = String(query.id || '');
  if (!c || !ENTITY.test(id) || domainOf(id) !== 'camera' || (c.chosen && c.chosen.indexOf(id) === -1)) return refuse(res, 404);
  var live = query.live === '1';
  request(c.server, c.token, '/api/' + (live ? 'camera_proxy_stream/' : 'camera_proxy/') + id, null, true, function (err, status, upstream) {
    if (err || status !== 200) {
      if (upstream) upstream.resume();
      return refuse(res, 502);
    }
    res.writeHead(200, { 'Content-Type': upstream.headers['content-type'] || 'image/jpeg', 'Cache-Control': 'no-store' });
    upstream.pipe(res);
    res.on('close', function () { upstream.destroy(); });
  });
}

// ------------------------------------------------------------- Home Assistant's own dashboard

function openDashboard(cb) {
  var c = config();
  if (!c) return cb({ ok: false, error: msg('srv.ha.none', 'Home Assistant is not linked') });
  if (!control) return cb({ ok: false, error: 'not ready' });
  control('launchUrl', c.server + '/', function (r) { cb(r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || 'no answer' }); });
}

// ------------------------------------------------------------- linking and choosing, from a phone

function status() {
  var c = config();
  if (!c) return { ok: true, configured: false };
  return { ok: true, configured: true, server: parseUrl(c.server).host, place: c.place, chosen: c.chosen ? c.chosen.length : null };
}

// The page's code: the one shown stays while used, so linking and choosing take one scan.
function pair(origin) {
  if (!origin) return { ok: false, error: msg('srv.home.jfNoNetwork', 'the TV has no address a phone can reach') };
  var now = nowMs();
  for (var k in codes) if (codes[k] < now) delete codes[k];
  for (var c in codes) {
    codes[c] = now + CODE_IDLE_MS;
    return { ok: true, url: origin + '/ha?c=' + c };
  }
  var code = crypto.randomBytes(8).toString('hex');
  codes[code] = now + CODE_IDLE_MS;
  return { ok: true, url: origin + '/ha?c=' + code };
}

function codeValid(code) {
  if (typeof code !== 'string' || !codes.hasOwnProperty(code) || codes[code] < nowMs()) return false;
  codes[code] = nowMs() + CODE_IDLE_MS;
  return true;
}

function expired() {
  return { ok: false, expired: true, error: msg('srv.ha.expired', 'This code has expired. Open Home Assistant in the TV\'s Home settings for a new one.') };
}

/*
 * From the phone: { c, server, token }, tried on /api/config before it is
 * kept; or { c, check: true } as the page opens, which says whether a server
 * is linked already, so the page can go straight to choosing.
 */
function link(body, cb) {
  if (!body || !codeValid(body.c)) return cb(expired());
  if (body.check === true) return cb({ ok: true, valid: true, linked: !!config(), place: config() ? config().place : '' });
  var server = normaliseServer(body.server);
  var token = String(body.token || '').trim();
  if (!server) return cb({ ok: false, error: msg('srv.home.jfServer', 'the server address is not valid') });
  if (!/^[A-Za-z0-9_\-.]{20,1000}$/.test(token)) return cb({ ok: false, error: msg('srv.ha.token', 'that is not a long-lived access token: make one in Home Assistant, Profile, Security') });
  request(server, token, '/api/config', null, false, function (err, st, conf) {
    if (err) return cb({ ok: false, error: msg('srv.ha.unreachable', 'Home Assistant did not answer: {error}', { error: err.message }) });
    if (st === 401 || st === 403) return cb({ ok: false, error: msg('srv.ha.refused', 'Home Assistant refused the token') });
    if (st !== 200 || !conf || typeof conf !== 'object' || !conf.version) {
      return cb({ ok: false, error: msg('srv.ha.notHa', 'that address did not answer as Home Assistant; its port is usually 8123') });
    }
    var was = config();
    try {
      save({ server: server, token: token, place: String(conf.location_name || ''), chosen: was && was.server === server ? was.chosen : null });
    } catch (e) {
      return cb({ ok: false, error: msg('srv.ha.saveFailed', 'could not save the Home Assistant details') });
    }
    console.log('auror-ha: linked from a phone, ' + (conf.location_name || server) + ', Home Assistant ' + conf.version);
    cb({ ok: true, place: String(conf.location_name || ''), version: String(conf.version) });
  });
}

// Every entity the panel could show, for the phone to choose from.
function entities(code, cb) {
  if (!codeValid(code)) return cb(expired());
  var c = config();
  if (!c) return cb({ ok: false, error: msg('srv.ha.none', 'Home Assistant is not linked') });
  allStates(function (error, list) {
    if (error) return cb({ ok: false, error: error });
    states(function (now) {
      var shown = now.ok ? now.entities.map(function (e) { return e.id; }) : [];
      cb({ ok: true, place: c.place, groups: GROUPS.map(function (g) { return g.id; }),
        entities: list.map(function (s) { var v = view(s); return { id: v.id, group: v.group, name: v.name, shown: shown.indexOf(v.id) !== -1 }; })
          .sort(function (x, y) { return x.name < y.name ? -1 : x.name > y.name ? 1 : 0; }) });
    });
  });
}

function choose(body, cb) {
  if (!body || !codeValid(body.c)) return cb(expired());
  var c = config();
  if (!c) return cb({ ok: false, error: msg('srv.ha.none', 'Home Assistant is not linked') });
  var ids = (isList(body.ids) ? body.ids : []).filter(function (id) { return typeof id === 'string' && ENTITY.test(id) && groupOf(id); });
  if (ids.length > MAX_CHOSEN) return cb({ ok: false, error: msg('srv.ha.tooMany', 'at most {n} on the TV', { n: MAX_CHOSEN }) });
  try {
    save({ server: c.server, token: c.token, place: c.place, chosen: ids });
  } catch (e) {
    return cb({ ok: false, error: msg('srv.ha.saveFailed', 'could not save the Home Assistant details') });
  }
  cb({ ok: true, chosen: ids.length });
}

function forget(cb) {
  util.unlinkQuiet(file());
  cfg = null;
  statesCache = null;
  cb({ ok: true, configured: false });
}

module.exports = {
  init: init,
  states: states,
  act: act,
  camera: camera,
  openDashboard: openDashboard,
  status: status,
  pair: pair,
  codeValid: codeValid,
  link: link,
  entities: entities,
  choose: choose,
  forget: forget
};
