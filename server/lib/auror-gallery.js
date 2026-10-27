/*
 * lib/auror-gallery.js - AUROR's own backgrounds on Glasshouse Home: photos
 * put on the TV from a phone or computer on the same network, behind Home
 * one at a time or in turn.
 *
 * The page for them (assets/gallery-phone.html) is reached from the QR code
 * in Home's settings, whose code stands in for the token as Jellyfin's and
 * TMDB's do; it stays good while it is used. The browser shrinks each photo
 * to 1920 x 1080 at most and makes a small copy for the list, both JPEG,
 * checked again here as lib/home-wallpapers checks its own.
 *
 * Chosen, a photo stands in for Glasshouse's wallpapers in what the view is
 * told (wall): the same crossfade and the same dimming by time of day. In
 * turn, which one is shown follows from the clock, so it needs no timer:
 * the view hears of the next one with its heartbeat.
 *
 * Strict ES5: runs on node 0.12.
 */
var fs = require('fs');
var path = require('path');
var crypto = require('crypto');
var execFile = require('child_process').execFile;
var util = require('./util');
var installer = require('./installer');
var validJpeg = require('./home-wallpapers').validJpeg;
var msg = require('./say').msg;

var MODES = ['off', 'one', 'rotate'];
// Minutes between photos in turn.
var EVERY = [5, 15, 30, 60, 180];
var MAX_PHOTOS = 60;
var MAX_PHOTO = 5 * 1024 * 1024;
var MAX_THUMB = 512 * 1024;
// Free space kept on the TV's /var beyond each photo.
var KEEP_FREE = 20 * 1024 * 1024;
var CODE_IDLE_MS = 30 * 60000;
var ID = /^[0-9a-z]{6,12}-[0-9a-f]{4}$/;

var dir = '/var/lib/tvweb/auror-photos';
var settingsFile = '/var/lib/tvweb/auror-photos.json';
var nowMs = Date.now;
var codes = {};
var uploading = false;
var saved = null;

/**
 * @param {Object} opts
 * @param {string} opts.stateDir
 * @param {function(): number} [opts.now] for tests
 */
function init(opts) {
  dir = path.join(opts.stateDir, 'auror-photos');
  settingsFile = path.join(opts.stateDir, 'auror-photos.json');
  nowMs = opts.now || Date.now;
  codes = {};
  uploading = false;
  saved = null;
}

function settings() {
  if (saved) return saved;
  var raw = null;
  try { raw = JSON.parse(fs.readFileSync(settingsFile, 'utf8')); } catch (e) {}
  saved = { mode: 'off', photo: null, every: 30 };
  if (raw && typeof raw === 'object') {
    if (MODES.indexOf(raw.mode) !== -1) saved.mode = raw.mode;
    if (typeof raw.photo === 'string' && ID.test(raw.photo)) saved.photo = raw.photo;
    if (EVERY.indexOf(raw.every) !== -1) saved.every = raw.every;
  }
  return saved;
}

function save(next) {
  try {
    util.writeJsonAtomic(settingsFile, next, 384);
  } catch (e) {
    return false;
  }
  saved = next;
  return true;
}

function photoFile(id) { return path.join(dir, id + '.jpg'); }
function thumbFile(id) { return path.join(dir, id + '.thumb.jpg'); }

// Oldest first: the order they turn in, and the order of the TV's picker.
function list() {
  var names = [];
  try { names = fs.readdirSync(dir); } catch (e) {}
  var out = [];
  names.forEach(function (name) {
    var m = /^(.+)\.jpg$/.exec(name);
    if (!m || !ID.test(m[1])) return;
    var st = null;
    try { st = fs.statSync(path.join(dir, name)); } catch (e) {}
    if (!st || !st.isFile()) return;
    out.push({ id: m[1], at: Number(st.mtime), size: st.size, thumb: fs.existsSync(thumbFile(m[1])) });
  });
  out.sort(function (a, b) { return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; });
  return out;
}

// The photo behind Home now, or null for Glasshouse's own wallpapers.
function current() {
  var s = settings();
  if (s.mode === 'off') return null;
  var photos = list();
  if (!photos.length) return null;
  if (s.mode === 'one') {
    for (var i = 0; i < photos.length; i++) if (photos[i].id === s.photo) return photos[i];
    return photos[photos.length - 1];
  }
  return photos[Math.floor(nowMs() / (s.every * 60000)) % photos.length];
}

/*
 * What the view is told in place of lib/home-wallpapers' status while a
 * photo is chosen: every slot has it, and src says where it is.
 */
function wall() {
  var p = current();
  if (!p) return null;
  return { available: true, uploading: false, revision: 'p-' + p.id + '-' + p.at,
    slots: { morning: true, afternoon: true, evening: true, night: true },
    src: '/api/home/photo?id=' + p.id + '&v=' + p.at };
}

function file(id, thumb) {
  if (typeof id !== 'string' || !ID.test(id)) return null;
  var f = thumb ? thumbFile(id) : photoFile(id);
  if (thumb && !fs.existsSync(f)) f = photoFile(id);
  return fs.existsSync(f) ? f : null;
}

// For the TV's settings and the phone's page.
function status() {
  var s = settings(), photos = list(), p = current();
  return { ok: true, mode: s.mode, photo: s.photo, every: s.every, shown: p ? p.id : null,
    count: photos.length, max: MAX_PHOTOS, ids: photos.map(function (x) { return x.id; }) };
}

function setSettings(body) {
  if (!body || typeof body !== 'object') return { ok: false, error: 'settings expected' };
  var s = settings(), next = { mode: s.mode, photo: s.photo, every: s.every };
  if (body.mode !== undefined) {
    if (MODES.indexOf(body.mode) === -1) return { ok: false, error: 'unknown mode' };
    next.mode = body.mode;
  }
  if (body.photo !== undefined) {
    if (!file(body.photo)) return { ok: false, error: msg('srv.auror.photoGone', 'that photo is no longer on the TV') };
    next.photo = body.photo;
  }
  if (body.every !== undefined) {
    if (EVERY.indexOf(body.every) === -1) return { ok: false, error: 'unknown interval' };
    next.every = body.every;
  }
  if (!save(next)) return { ok: false, error: msg('srv.auror.photoSave', 'could not save the background setting') };
  return status();
}

// ------------------------------------------------------------- the phone's code

function pair(origin) {
  if (!origin) return { ok: false, error: msg('srv.home.jfNoNetwork', 'the TV has no address a phone can reach') };
  var now = nowMs();
  for (var k in codes) if (codes[k] < now) delete codes[k];
  // The one shown keeps going while the settings are open, so the QR code stays put.
  for (var c in codes) {
    codes[c] = now + CODE_IDLE_MS;
    return { ok: true, url: origin + '/photos?c=' + c };
  }
  var code = crypto.randomBytes(8).toString('hex');
  codes[code] = now + CODE_IDLE_MS;
  return { ok: true, url: origin + '/photos?c=' + code };
}

// A code in use stays good for another half hour.
function codeValid(code) {
  if (typeof code !== 'string' || !codes.hasOwnProperty(code) || codes[code] < nowMs()) return false;
  codes[code] = nowMs() + CODE_IDLE_MS;
  return true;
}

// ------------------------------------------------------------- uploads

function newId() {
  return nowMs().toString(36) + '-' + crypto.randomBytes(2).toString('hex');
}

/*
 * A JPEG in the request's body: kind 'photo' adds one and answers its id,
 * kind 'thumb' is the small copy of one just added.
 */
function upload(req, kind, id, cb) {
  function refused(text, code) { cb({ ok: false, error: text, status: code || 400 }); }
  var thumb = kind === 'thumb';
  if (!thumb && kind !== 'photo') return refused('unknown kind');
  if (thumb && !file(id)) return refused(msg('srv.auror.photoGone', 'that photo is no longer on the TV'), 404);
  if (!thumb && list().length >= MAX_PHOTOS) {
    return refused(msg('srv.auror.photoMax', 'The TV keeps {n} photos at most. Remove some first.', { n: MAX_PHOTOS }), 409);
  }
  if (uploading) return refused(msg('srv.home.wallUploading', 'Wait for the wallpaper upload to finish.'), 409);
  var max = thumb ? MAX_THUMB : MAX_PHOTO;
  var length = String(req.headers['content-length'] || '');
  if (req.headers['transfer-encoding'] || !/^\d{1,8}$/.test(length) || +length < 1 || +length > max) {
    return refused(msg('srv.auror.photoSize', 'A photo must be at most 5 MB and state its size.'), 413);
  }
  uploading = true;
  var chunks = [], got = 0, ended = false, finished = false;
  var timer = setTimeout(function () { finish(msg('srv.home.wallUploadTimeout', 'The wallpaper upload timed out.'), 408); }, 60000);
  function finish(text, code, abandoned, answer) {
    if (finished) return;
    finished = true;
    clearTimeout(timer);
    chunks = [];
    uploading = false;
    if (abandoned) return;
    if (text) return refused(text, code);
    cb(answer);
  }
  req.on('aborted', function () { if (!ended) finish(null, null, true); });
  req.on('error', function () { if (!ended) finish(null, null, true); });
  req.on('close', function () { if (!ended) finish(null, null, true); });
  req.on('data', function (chunk) {
    if (finished) return;
    got += chunk.length;
    if (got > +length) return finish(msg('srv.auror.photoSize', 'A photo must be at most 5 MB and state its size.'), 413);
    chunks.push(chunk);
  });
  req.on('end', function () {
    if (finished) return;
    ended = true;
    var buf = Buffer.concat(chunks);
    chunks = [];
    if (got !== +length || !validJpeg(buf)) {
      return finish(msg('srv.home.wallUploadImage', 'Choose a valid JPEG up to 1920 × 1080 pixels.'));
    }
    try { if (!fs.existsSync(dir)) fs.mkdirSync(dir); }
    catch (e) { return finish(e.message, 500); }
    execFile('df', ['-k', dir], { timeout: 5000 }, function (err, out) {
      var free = err ? null : installer.parseDf(out);
      if (free === null || free < buf.length + KEEP_FREE) {
        return finish(msg('srv.auror.photoSpace', 'The TV has not enough free space for another photo.'), 507);
      }
      var name = thumb ? id : newId();
      var target = thumb ? thumbFile(name) : photoFile(name), staging = target + '.part';
      fs.writeFile(staging, buf, { mode: parseInt('600', 8) }, function (writeError) {
        if (writeError) { util.unlinkQuiet(staging); return finish(writeError.message, 500); }
        fs.rename(staging, target, function (renameError) {
          if (renameError) { util.unlinkQuiet(staging); return finish(renameError.message, 500); }
          console.log('auror: photo ' + name + (thumb ? ' thumbnail' : '') + ' added, ' + buf.length + ' bytes');
          finish(null, null, false, { ok: true, id: name });
        });
      });
    });
  });
}

function remove(id) {
  if (typeof id !== 'string' || !ID.test(id)) return { ok: false, error: 'unknown photo' };
  if (uploading) return { ok: false, error: msg('srv.home.wallUploading', 'Wait for the wallpaper upload to finish.') };
  [photoFile(id), thumbFile(id)].forEach(util.unlinkQuiet);
  var s = settings();
  if (s.photo === id) save({ mode: s.mode, photo: null, every: s.every });
  console.log('auror: photo ' + id + ' removed');
  return status();
}

module.exports = {
  init: init,
  list: list,
  wall: wall,
  file: file,
  status: status,
  setSettings: setSettings,
  pair: pair,
  codeValid: codeValid,
  upload: upload,
  remove: remove,
  EVERY: EVERY
};
