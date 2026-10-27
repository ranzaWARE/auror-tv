// Strict ES5 - node v0.12.2 on webOS 4 (LG OLED B8) has no ES6 support.
var msg = require('./say').msg;

/*
 * AUROR keeps the TV on its own releases without anyone pressing Install.
 * Every few hours it asks GitHub for the latest AUROR release, and installs
 * one that is newer while the TV is off with the server still up, or in the
 * small hours, so nothing on screen is cut short by the server's restart.
 * config.json's update.auto set to false leaves it to the Install button.
 */
var CHECK_EVERY_MS = 3 * 3600000;
// Local hours [from, to) in which an install may go ahead with the TV on.
var NIGHT_FROM = 3, NIGHT_TO = 5;
// A failed install waits this long before it is tried again.
var RETRY_AFTER_MS = 12 * 3600000;

/** @type {typeof import('./updater')} */
var updater = null;
var config = {};
var control = null;
var tvOff = function () { return false; };
var writeSettings = null;
var now = function () { return new Date(); };
var log = console.log;
var timer = null;
var failedAt = 0;

function autoOn() { return !(config.update && config.update.auto === false); }

function quietTime() {
  var h = now().getHours();
  return tvOff() || (h >= NIGHT_FROM && h < NIGHT_TO);
}

// One look: a check (kept for three hours), then an install if one is due and the time is right.
function tick(cb) {
  cb = cb || function () {};
  if (!autoOn() || !updater || updater.isBusy()) return cb('skipped');
  updater.checkForUpdate(CHECK_EVERY_MS, function (err, summary) {
    if (err || !summary || !summary.available) return cb('current');
    if (!quietTime()) return cb('waiting');
    if (failedAt && Date.now() - failedAt < RETRY_AFTER_MS) return cb('waiting');
    log('update: installing v' + summary.latest + ' on its own (AUROR automatic updates)');
    control('update', null, function (r) {
      if (!r || !r.ok) {
        failedAt = Date.now();
        console.error('update: the automatic install failed: ' + ((r && r.error) || 'unknown error'));
        return cb('failed');
      }
      failedAt = 0;
      cb('installed');
    });
  });
}

function status() {
  var s = updater ? updater.updateSummary() : {};
  return { auto: autoOn(), installed: s.installed || null, latest: s.latest || null, available: !!s.available };
}

function setAuto(on, cb) {
  if (!writeSettings) return cb({ ok: false, error: 'no writeSettings handler configured' });
  writeSettings({ update: { auto: on } }, function (err) {
    if (err) return cb({ ok: false, error: msg('srv.saveSettingFailed', 'could not save the setting: {error}', { error: err.message }) });
    config.update = config.update || {};
    config.update.auto = on;
    log('update: AUROR automatic updates switched ' + (on ? 'on' : 'off'));
    cb({ ok: true, update: status() });
  });
}

/**
 * @param {Object} opts
 * @param {typeof import('./updater')} opts.updater
 * @param {Object} opts.config the server's config, read for update.auto
 * @param {function(string, any, function(Object): void): void} opts.control doControl, whose 'update' installs and restarts
 * @param {function(): boolean} opts.tvOff true while the TV is in standby with the server up
 * @param {function(Object, function(?Error): void): void} opts.writeSettings
 * @param {number} [opts.firstMs] the first look, after start
 * @param {function(): Date} [opts.now] for tests
 * @param {function(string): void} [opts.log] for tests
 */
function start(opts) {
  updater = opts.updater;
  config = opts.config || {};
  control = opts.control;
  tvOff = opts.tvOff || tvOff;
  writeSettings = opts.writeSettings || null;
  if (opts.now) now = opts.now;
  if (opts.log) log = opts.log;
  failedAt = 0;
  if (timer) clearInterval(timer);
  timer = null;
  if (opts.firstMs === 0) return;
  setTimeout(function () { tick(); }, opts.firstMs || 600000);
  // Half-hourly, so a TV switched off in the evening is updated soon after;
  // GitHub itself is asked at most every three hours.
  timer = setInterval(function () { tick(); }, CHECK_EVERY_MS / 6);
}

module.exports = {
  start: start,
  tick: tick,
  status: status,
  setAuto: setAuto,
  autoOn: autoOn
};
