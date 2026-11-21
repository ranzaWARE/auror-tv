/*
 * lib/auror-song.js - the song playing, title and artist, for the AUROR screen
 * saver to write under the clock while Mimus plays along.
 *
 * Asked of com.webos.service.mediacontroller, where a music app's media
 * session is published (webOS OSE's API: getActiveMediaSessions, then
 * getMediaMetaData for the session's mediaId). A C1 (webOS 6.5.3) has no such
 * service: once the bus says it does not exist, it is not asked again, and the
 * saver shows the clock alone. Whatever the session does not give is left out.
 *
 * Strict ES5: runs on node 0.12.
 */

var SERVICE = 'com.webos.service.mediacontroller';
var CACHE_MS = 4000;

var luna = null;
var nowMs = Date.now;
var absent = false;
var cache = null;
var waiting = null;

/**
 * @param {Object} opts
 * @param {function(string, Object, function(any): void): void} opts.luna
 * @param {function(): number} [opts.now] for tests
 */
function init(opts) {
  luna = opts.luna;
  nowMs = opts.now || Date.now;
  absent = false;
  cache = null;
  waiting = null;
}

function text(v) {
  return typeof v === 'string' ? v.replace(/[\u0000-\u001f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120) : '';
}

function missing(r) { return !!r && /does not exist|Unknown method/i.test(String(r.errorText || '')); }

// The first active session's mediaId, or null.
function sessionOf(r) {
  var list = r && r.returnValue !== false ? (r.activeMediaSessions || r.mediaSessions || r.sessions) : null;
  if (Object.prototype.toString.call(list) !== '[object Array]') return null;
  for (var i = 0; i < list.length; i++) {
    var s = list[i];
    if (typeof s === 'string' && s) return s;
    if (s && typeof s.mediaId === 'string' && s.mediaId) return s.mediaId;
  }
  return null;
}

function songOf(r) {
  var meta = r && r.returnValue !== false ? (r.mediaMetaData || r.metaData || r.metadata) : null;
  if (!meta || typeof meta !== 'object') return null;
  var song = { title: text(meta.title), artist: text(meta.artist), album: text(meta.album) };
  return song.title ? song : null;
}

// cb({ title, artist, album } or null), the same answer for four seconds.
function read(cb) {
  if (!luna || absent) return cb(null);
  if (cache && nowMs() - cache.at < CACHE_MS) return cb(cache.song);
  if (waiting) return waiting.push(cb);
  waiting = [cb];
  function answer(song) {
    cache = { at: nowMs(), song: song };
    var list = waiting;
    waiting = null;
    list.forEach(function (w) { w(song); });
  }
  luna(SERVICE + '/getActiveMediaSessions', {}, function (r) {
    if (missing(r)) absent = true;
    var mediaId = sessionOf(r);
    if (!mediaId) return answer(null);
    luna(SERVICE + '/getMediaMetaData', { mediaId: mediaId }, function (m) {
      answer(songOf(m));
    });
  });
}

module.exports = { init: init, read: read };
