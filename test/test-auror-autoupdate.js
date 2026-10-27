/* AUROR's automatic updates: a newer release goes in with the TV off or in
 * the small hours, never while someone may be watching, and not at all once
 * switched off. Strict ES5: also runs on node 0.10. */
var assert = require('assert');
var auto = require('../server/lib/auror-autoupdate');

var summary, installs, settings, off, hour, installOk, busy;
var config = { update: {} };
var updater = {
  isBusy: function () { return busy; },
  checkForUpdate: function (minAge, cb) { cb(null, summary); },
  updateSummary: function () { return summary; }
};
function reset() {
  summary = { available: true, latest: '0.122.201', installed: '0.122.200' };
  installs = 0; settings = []; off = false; hour = 14; installOk = true; busy = false;
  config.update = {};
  auto.start({
    updater: updater, config: config, firstMs: 0, log: function () {},
    control: function (action, v, cb) { assert.strictEqual(action, 'update'); installs++; cb(installOk ? { ok: true, updated: true } : { ok: false, error: 'no network' }); },
    tvOff: function () { return off; },
    writeSettings: function (patch, cb) { settings.push(patch); cb(null); },
    now: function () { var d = new Date(2026, 9, 27, hour, 30); return d; }
  });
}
function tick() { var got; auto.tick(function (r) { got = r; }); return got; }

var steps = [];
function step(name, fn) { steps.push([name, fn]); }

step('a newer release waits while the TV is on in the day', function () {
  reset();
  assert.strictEqual(tick(), 'waiting');
  assert.strictEqual(installs, 0);
});

step('it goes in once the TV is off', function () {
  reset();
  off = true;
  assert.strictEqual(tick(), 'installed');
  assert.strictEqual(installs, 1);
});

step('or between 03:00 and 05:00 with the TV on', function () {
  reset();
  hour = 3;
  assert.strictEqual(tick(), 'installed');
  hour = 5;
  assert.strictEqual(tick(), 'waiting');
});

step('nothing newer, nothing installed', function () {
  reset();
  off = true;
  summary.available = false;
  assert.strictEqual(tick(), 'current');
  assert.strictEqual(installs, 0);
});

step('switched off in config.json, it leaves it to the Install button', function () {
  reset();
  off = true;
  config.update.auto = false;
  assert.strictEqual(tick(), 'skipped');
  assert.strictEqual(auto.status().auto, false);
});

step('a running update is not started again', function () {
  reset();
  off = true;
  busy = true;
  assert.strictEqual(tick(), 'skipped');
});

step('a failed install waits before it is tried again', function () {
  reset();
  off = true;
  installOk = false;
  assert.strictEqual(tick(), 'failed');
  installOk = true;
  assert.strictEqual(tick(), 'waiting');
  assert.strictEqual(installs, 1);
});

step('the view\'s switch is kept in config.json', function () {
  reset();
  var reply;
  auto.setAuto(false, function (r) { reply = r; });
  assert.deepEqual(settings, [{ update: { auto: false } }]);
  assert.strictEqual(reply.ok, true);
  assert.strictEqual(reply.update.auto, false);
  assert.strictEqual(reply.update.latest, '0.122.201');
});

step('Update now installs a newer release at once, by day with the TV on', function () {
  reset();
  var reply;
  auto.updateNow(function (r) { reply = r; });
  assert.strictEqual(installs, 1);
  assert.strictEqual(reply.installing, true);
  assert.strictEqual(reply.version, '0.122.201');
});

step('Update now with nothing newer says so and installs nothing', function () {
  reset();
  summary.available = false;
  var reply;
  auto.updateNow(function (r) { reply = r; });
  assert.strictEqual(installs, 0);
  assert.strictEqual(reply.ok, true);
  assert.strictEqual(reply.installing, false);
});

steps.forEach(function (s) {
  s[1]();
  console.log('  ✓ ' + s[0]);
});
console.log('ALL test-auror-autoupdate.js assertions passed!');
