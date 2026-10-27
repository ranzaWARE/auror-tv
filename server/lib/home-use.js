/*
 * lib/home-use.js - how much each tile on Glasshouse Home is used, for the
 * rows set to Most used (lib/home)
 *
 * A count of opens per tile id and row that halves every three weeks, so an
 * app no longer used drifts back down. Kept in /var/lib/tvweb/home-use.json,
 * as home-recent.json keeps the times: only for the rows that use it, and a
 * row is forgotten once it goes back to its own order.
 *
 * Strict ES5: runs on node 0.12.
 */
var fs = require('fs');
var path = require('path');
var writeJsonAtomic = require('./util').writeJsonAtomic;

var ROWS = ['app', 'dev', 'ch'];
var HALF_LIFE_MS = 21 * 24 * 3600000;
var MAX_IDS = 100;
var SAVE_DELAY_MS = 5000;

var file = '/var/lib/tvweb/home-use.json';
var nowMs = Date.now;
var counts = null;
var saveTimer = null;

function init(stateDir, now) {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  file = path.join(stateDir, 'home-use.json');
  nowMs = now || Date.now;
  counts = null;
}

function load() {
  if (counts) return counts;
  counts = { app: {}, dev: {}, ch: {} };
  var raw = null;
  try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (e) {}
  ROWS.forEach(function (r) {
    var row = raw && typeof raw === 'object' && raw[r];
    if (!row || typeof row !== 'object') return;
    for (var id in row) {
      var c = Object.prototype.hasOwnProperty.call(row, id) && row[id];
      if (c && typeof c.n === 'number' && typeof c.at === 'number' && id.length <= 200) counts[r][id] = { n: c.n, at: c.at };
    }
  });
  return counts;
}

function save() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = null;
  if (!counts) return;
  try {
    writeJsonAtomic(file, counts, 384);
  } catch (e) {
    console.error('home: could not save home-use.json: ' + e.message);
  }
}

function weight(c, at) { return c ? c.n * Math.pow(0.5, (at - c.at) / HALF_LIFE_MS) : 0; }

function count(row, id) {
  if (ROWS.indexOf(row) === -1 || typeof id !== 'string' || !id || id.length > 200) return;
  var t = load()[row], at = nowMs();
  t[id] = { n: weight(t[id], at) + 1, at: at };
  var ids = Object.keys(t);
  if (ids.length > MAX_IDS) {
    ids.sort(function (a, b) { return weight(t[a], at) - weight(t[b], at); });
    ids.slice(0, ids.length - MAX_IDS).forEach(function (old) { delete t[old]; });
  }
  if (!saveTimer) saveTimer = setTimeout(save, SAVE_DELAY_MS);
}

// { id: weight now } for a row.
function of(row) {
  var t = load()[row] || {}, at = nowMs(), out = {};
  for (var id in t) if (Object.prototype.hasOwnProperty.call(t, id)) out[id] = weight(t[id], at);
  return out;
}

function forget(row) {
  var t = load();
  if (!t[row] || !Object.keys(t[row]).length) return;
  t[row] = {};
  if (!ROWS.some(function (r) { return Object.keys(t[r]).length; })) {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = null;
    try { fs.unlinkSync(file); } catch (e) {}
    return;
  }
  save();
}

module.exports = {
  init: init,
  count: count,
  of: of,
  forget: forget,
  flush: function () { if (saveTimer) save(); }
};
