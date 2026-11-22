/* Who may reach AUROR's Home Assistant panel through routes.handleRequest:
 * only the TV's own pages. A page reached through a rebinding name
 * (evil.example resolving to 127.0.0.1) is refused. Timers and Date.now run
 * on a fake clock. Strict ES5. */
var assert = require('assert');
var events = require('events');
var fs = require('fs');
var os = require('os');
var path = require('path');

var now = 1000000;
var timers = [];
var realSetTimeout = setTimeout, realClearTimeout = clearTimeout, realDateNow = Date.now;
global.setTimeout = function (fn, ms) { var t = { fn: fn, ms: ms, at: now + ms }; timers.push(t); return t; };
global.clearTimeout = function (t) { var i = timers.indexOf(t); if (i !== -1) timers.splice(i, 1); };
Date.now = function () { return now; };
// Runs every timer due by now, as the clock reaching it would.
function advance(ms) {
  now += ms;
  timers.filter(function (t) { return t.at <= now; }).forEach(function (t) {
    global.clearTimeout(t);
    t.fn();
  });
}

var realLog = console.log;
var logged = [];
console.log = function () { logged.push(Array.prototype.join.call(arguments, ' ')); };
function say(line) { realLog.call(console, line); }

var routes = require('../server/lib/routes');
var aurorTv = require('../server/lib/auror-tv');
var aurorHa = require('../server/lib/auror-ha');

say('Running test-auror-access.js ...');

var dir = path.join(os.tmpdir(), 'auror-access-' + process.pid);
fs.mkdirSync(dir);
fs.mkdirSync(path.join(dir, 'proc'));
var dropbear = path.join(dir, 'dropbear');
fs.writeFileSync(dropbear, '');
var flag = path.join(dir, 'webosbrew_sshd_enabled');

aurorHa.init({ stateDir: dir });
aurorTv.init({
  luna: function (uri, params, cb) { cb(null); },
  control: function (kind, value, cb) { cb({ ok: true }); },
  procDir: path.join(dir, 'proc'), sshFlag: flag, dropbear: dropbear, sshStateDir: path.join(dir, 'sshd'),
  spawn: function () { return { unref: function () {} }; },
  kill: function () {},
  sshkeys: { status: function (cb) { cb({ passwordNow: true, passwordAfterReboot: true, keys: [] }); } }
});
var config = { token: '', allowControl: true, host: '::' };
routes.init({ config: config, home: { enabled: function () { return true; } } });

function setConfig(token, allowControl) {
  config.token = token;
  config.allowControl = allowControl;
}

/*
 * One request through handleRequest. Every request carries a Host, as a
 * browser's does; host: '' sends none. The reply comes back synchronously,
 * or after advance(600) for an SSH switch that went ahead.
 */
function request(o) {
  var req = new events.EventEmitter();
  req.url = o.url;
  req.method = o.method || 'GET';
  req.headers = {};
  if (o.host !== '') req.headers.host = o.host || 'localhost:8080';
  if (o.origin) req.headers.origin = o.origin;
  if (o.auth) req.headers.authorization = o.auth;
  if (req.method === 'POST') req.headers['content-type'] = 'application/json';
  req.connection = { remoteAddress: o.from };
  req.setEncoding = function () {};
  var res = {
    statusCode: null, body: '', done: false,
    writeHead: function (code) { res.statusCode = code; },
    end: function (chunk) { if (chunk) res.body += chunk.toString(); res.done = true; },
    on: function () {}
  };
  routes.handleRequest(req, res);
  if (req.method === 'POST') {
    req.emit('data', JSON.stringify(o.body || {}));
    req.emit('end');
  }
  if (!res.done) advance(600);
  assert.ok(res.done, 'answered');
  res.json = res.body.charAt(0) === '{' ? JSON.parse(res.body) : null;
  return res;
}

function flagSet() { return fs.existsSync(flag); }
function resetSsh() {
  if (flagSet()) fs.unlinkSync(flag);
  timers = [];
}

var failures = [], failedBefore = 0;
function row(name, fn) {
  try { fn(); } catch (e) { failures.push(name); say('  ✗ ' + name + ': ' + e.message.replace(/\s+/g, ' ')); }
  resetSsh();
}
// Ticks a group of rows off only when none of them failed.
function done(what) {
  say((failures.length === failedBefore ? '  ✓ ' : '  ✗ ') + what);
  failedBefore = failures.length;
}

var LAN = '192.168.8.10';
var TV_ADDRESSES = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];
var TV_HOSTS = ['localhost:8080', '127.0.0.1:8080', '[::1]:8080'];

// ---- Home Assistant's panel: the TV's own pages only, never with a token instead
setConfig('', true);
TV_ADDRESSES.concat([LAN]).forEach(function (from) {
  TV_HOSTS.concat(['evil.example:8080', '']).forEach(function (host) {
    var tvPage = from !== LAN && TV_HOSTS.indexOf(host) !== -1;
    row('ha/states from ' + from + ' Host ' + (host || '(none)'), function () {
      var r = request({ url: '/api/home/ha/states', from: from, host: host });
      assert.strictEqual(r.statusCode, tvPage ? 400 : 403, 'unlinked 400 from the TV, 403 otherwise');
    });
  });
});
done('ha/states answers 127.0.0.1, ::1 and ::ffff:127.0.0.1 under localhost or an IP, nothing else');

row('HA panel from the TV, unlinked', function () {
  assert.strictEqual(request({ url: '/api/home/ha/camera?id=camera.door', from: '127.0.0.1' }).statusCode, 404);
  var act = request({ url: '/api/home/ha/act', method: 'POST', from: '::1', host: '[::1]:8080' });
  assert.strictEqual(act.statusCode, 400);
  assert.strictEqual(act.json.error, 'that is not something the TV can do here');
});
row('HA panel from the network', function () {
  assert.strictEqual(request({ url: '/api/home/ha/camera?id=camera.door', from: LAN, host: '192.168.8.2:8080' }).statusCode, 403);
  var act = request({ url: '/api/home/ha/act', method: 'POST', from: LAN, host: '192.168.8.2:8080' });
  assert.strictEqual(act.statusCode, 403);
  assert.strictEqual(act.json.error, 'Home Assistant\'s panel answers only the TV itself.');
});
row('HA panel from a rebinding page', function () {
  assert.strictEqual(request({ url: '/api/home/ha/camera?id=camera.door', from: '127.0.0.1', host: 'evil.example:8080' }).statusCode, 403);
  assert.strictEqual(request({ url: '/api/home/ha/act', method: 'POST', from: '127.0.0.1', host: 'evil.example:8080',
    origin: 'http://evil.example:8080' }).statusCode, 403);
});
setConfig('secret', true);
row('HA panel from the network with the token', function () {
  ['/api/home/ha/states?k=secret', '/api/home/ha/camera?id=camera.door&k=secret'].forEach(function (url) {
    assert.strictEqual(request({ url: url, from: LAN, host: '192.168.8.2:8080' }).statusCode, 403, url);
  });
  assert.strictEqual(request({ url: '/api/home/ha/act', method: 'POST', from: LAN, host: '192.168.8.2:8080',
    auth: 'Bearer secret' }).statusCode, 403);
});
row('HA act from another site', function () {
  var r = request({ url: '/api/home/ha/act', method: 'POST', from: '127.0.0.1', origin: 'http://evil.example' });
  assert.strictEqual(r.statusCode, 403);
  assert.strictEqual(r.json.error, 'cross-origin request refused');
});
done('camera and act likewise; the token does not open them, and another site is refused');

// ---- A refusal is logged once a minute per address and route
setConfig('', true);
row('refusals logged once a minute', function () {
  function refusals() { return logged.filter(function (l) { return l.indexOf('auror: refused /api/home/ha/states from 192.168.8.77') === 0; }).length; }
  request({ url: '/api/home/ha/states', from: '192.168.8.77', host: '192.168.8.2:8080' });
  assert.strictEqual(refusals(), 1);
  request({ url: '/api/home/ha/states', from: '192.168.8.77', host: '192.168.8.2:8080' });
  assert.strictEqual(refusals(), 1, 'not again within the minute');
  advance(60000);
  request({ url: '/api/home/ha/states', from: '192.168.8.77', host: '192.168.8.2:8080' });
  assert.strictEqual(refusals(), 2, 'again after it');
});
done('a refusal is logged once a minute per address and route');

global.setTimeout = realSetTimeout;
global.clearTimeout = realClearTimeout;
Date.now = realDateNow;
console.log = realLog;
fs.readdirSync(dir).forEach(function (f) {
  var p = path.join(dir, f);
  if (fs.statSync(p).isDirectory()) fs.rmdirSync(p); else fs.unlinkSync(p);
});
fs.rmdirSync(dir);

assert.deepEqual(failures, [], failures.length + ' rows failed');
say('test-auror-access.js passed');
