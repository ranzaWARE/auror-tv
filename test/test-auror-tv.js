/* AUROR's top bar and SSH setting (lib/auror-tv): the network's state, the
 * sleep timer, and the Homebrew Channel's SSH switch. Timers are captured
 * rather than waited for. Strict ES5: also runs on node 0.10. */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var tv = require('../server/lib/auror-tv');

var dir = path.join(os.tmpdir(), 'auror-tv-' + process.pid);
fs.mkdirSync(dir);
var proc = path.join(dir, 'proc');
fs.mkdirSync(proc);
var dropbear = path.join(dir, 'dropbear');
fs.writeFileSync(dropbear, '');
var flag = path.join(dir, 'webosbrew_sshd_enabled');

var now = 1000000, lunaCalls = 0, lunaReply = null, controls = [], spawned = [], killed = [];
var timers = [];
var realSetTimeout = setTimeout, realClearTimeout = clearTimeout;
global.setTimeout = function (fn, ms) { var t = { fn: fn, ms: ms, at: now + ms }; timers.push(t); return t; };
global.clearTimeout = function (t) { var i = timers.indexOf(t); if (i !== -1) timers.splice(i, 1); };
// Runs every timer due by now, as the clock reaching it would.
function advance(ms) {
  now += ms;
  timers.filter(function (t) { return t.at <= now; }).forEach(function (t) {
    global.clearTimeout(t);
    t.fn();
  });
}

tv.init({
  luna: function (uri, params, cb) { lunaCalls++; assert.strictEqual(uri, 'com.palm.connectionmanager/getStatus'); cb(lunaReply); },
  control: function (kind, value, cb) { controls.push([kind, value]); cb({ ok: true }); },
  now: function () { return now; },
  procDir: proc, sshFlag: flag, dropbear: dropbear, sshStateDir: path.join(dir, 'sshd'),
  spawn: function (file, args) { spawned.push([file].concat(args)); return { unref: function () {} }; },
  kill: function (pid, signal) { killed.push([pid, signal]); }
});

// ---- network
lunaReply = { isInternetConnectionAvailable: true, wired: { state: 'disconnected' },
  wifi: { state: 'connected', ssid: 'Casa', ipAddress: '192.168.1.42', onInternet: 'yes' } };
tv.networkStatus(function (r) {
  assert.deepEqual(r, { ok: true, kind: 'wifi', state: 'online', ssid: 'Casa', ip: '192.168.1.42' });
});
lunaReply = { isInternetConnectionAvailable: false, wired: { state: 'connected', ipAddress: '10.0.0.5', onInternet: 'no' }, wifi: { state: 'disconnected' } };
tv.networkStatus(function (r) { assert.strictEqual(r.kind, 'wifi', 'kept for 15 s'); });
assert.strictEqual(lunaCalls, 1);
now += 16000;
tv.networkStatus(function (r) {
  assert.deepEqual(r, { ok: true, kind: 'wired', state: 'limited', ssid: null, ip: '10.0.0.5' }, 'connected with no internet is limited');
});
now += 16000;
lunaReply = { wired: { state: 'disconnected' }, wifi: { state: 'disconnected' } };
tv.networkStatus(function (r) { assert.strictEqual(r.state, 'off'); assert.strictEqual(r.kind, 'none'); });
console.log('  ✓ the network is Wi-Fi, cable or none; online, limited or off');

// ---- sleep timer
assert.strictEqual(tv.sleepStatus().minutes, 0);
assert.strictEqual(tv.nextSleep().minutes, 30);
assert.strictEqual(tv.nextSleep().minutes, 60);
assert.strictEqual(tv.nextSleep().minutes, 90);
assert.strictEqual(tv.nextSleep().minutes, 120);
assert.strictEqual(tv.nextSleep().minutes, 0, 'after two hours, off');
assert.strictEqual(timers.length, 0, 'off leaves no timer behind');
tv.nextSleep();
advance(29 * 60000 - 1);
assert.deepEqual(controls, []);
advance(1);
assert.strictEqual(controls.length, 1);
assert.strictEqual(controls[0][0], 'toast', 'a minute before, a toast says so');
assert.strictEqual(tv.sleepStatus().minutes, 1);
advance(60000);
assert.deepEqual(controls[1], ['powerOff', null]);
assert.strictEqual(tv.sleepStatus().minutes, 0);
console.log('  ✓ the timer goes 30, 60, 90, 120 minutes, then off; warns, then switches off');

controls = [];
tv.setSleep(30);
tv.powerChanged(false);
advance(31 * 60000);
assert.deepEqual(controls, [], 'switched off some other way, the timer is gone');
console.log('  ✓ the TV switched off otherwise cancels the timer');

// Kept across a restart of the server, as an update at night makes.
var keptDir = path.join(dir, 'state');
fs.mkdirSync(keptDir);
var tvOpts = {
  luna: function () {}, control: function (kind, value, cb) { controls.push([kind, value]); cb({ ok: true }); },
  now: function () { return now; }, stateDir: keptDir
};
tv.init(tvOpts);
tv.setSleep(60);
assert.ok(fs.existsSync(path.join(keptDir, 'auror-sleep.json')));
now += 10 * 60000;
tv.init(tvOpts);
assert.strictEqual(tv.sleepStatus().minutes, 50, 'the timer survives the restart');
controls = [];
advance(50 * 60000);
assert.deepEqual(controls.map(function (c) { return c[0]; }), ['toast', 'powerOff']);
assert.ok(!fs.existsSync(path.join(keptDir, 'auror-sleep.json')), 'and is forgotten once it has run');
console.log('  ✓ the timer is kept across a restart of the server');
tv.init({
  luna: function () {}, control: function () {}, now: function () { return now; },
  procDir: proc, sshFlag: flag, dropbear: dropbear, sshStateDir: path.join(dir, 'sshd'),
  spawn: function (file, args) { spawned.push([file].concat(args)); return { unref: function () {} }; },
  kill: function (pid, signal) { killed.push([pid, signal]); }
});

// ---- SSH
var steps = [
  function (next) {
    tv.sshStatus(function (s) {
      assert.strictEqual(s.enabled, false);
      assert.strictEqual(s.running, false);
      tv.setSsh(true, function (r) {
        assert.ok(r.ok);
        assert.strictEqual(r.enabled, true);
        assert.strictEqual(fs.readFileSync(flag, 'utf8'), '1', 'the flag the Homebrew Channel reads at boot');
        assert.deepEqual(spawned, [[dropbear, '-R']], 'dropbear started as the Homebrew Channel starts it');
        next();
      });
      advance(600);
    });
  },
  function (next) {
    // Running: switched on again, it is not started twice; off, it is stopped.
    fs.mkdirSync(path.join(proc, '4242'));
    fs.writeFileSync(path.join(proc, '4242', 'comm'), 'dropbear\n');
    fs.mkdirSync(path.join(proc, '77'));
    fs.writeFileSync(path.join(proc, '77', 'comm'), 'node\n');
    tv.setSsh(true, function () {
      assert.strictEqual(spawned.length, 1);
      tv.setSsh(false, function (r) {
        assert.strictEqual(r.enabled, false);
        assert.ok(!fs.existsSync(flag));
        assert.deepEqual(killed, [[4242, 'SIGTERM']], 'only dropbear is stopped');
        next();
      });
      advance(600);
    });
    advance(600);
  },
  function (next) {
    fs.unlinkSync(dropbear);
    fs.rmdirSync(path.join(dir, 'sshd'));
    fs.unlinkSync(path.join(proc, '4242', 'comm'));
    tv.setSsh(true, function (r) {
      assert.strictEqual(r.ok, false, 'without the Homebrew Channel\'s dropbear, it says so');
      next();
    });
  }
];
(function run(i) {
  if (i < steps.length) return steps[i](function () { run(i + 1); });
  console.log('  ✓ SSH: the Homebrew Channel\'s flag, and dropbear started or stopped at once');
  global.setTimeout = realSetTimeout;
  global.clearTimeout = realClearTimeout;
  console.log('ALL test-auror-tv.js assertions passed!');
})(0);
