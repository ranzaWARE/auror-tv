/* The AUROR saver's beat each second, /api/home/look/beat, through the real
 * HTTP routes: the beat while Mimus follows it, null otherwise, and never a
 * read of the media state or a poll that would start the capture.
 * Strict ES5: also runs on node 0.10. */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var home = require('../server/lib/home');
var aurorBeat = require('../server/lib/auror-beat');
var routes = require('../server/lib/routes');

var dir = path.join(os.tmpdir(), 'auror-look-beat-' + process.pid);
fs.mkdirSync(dir);
home.init({ stateDir: dir, webosVersion: '6.5.3', port: 8080 });
routes.init({ config: { allowControl: true }, home: home,
  assetPath: function (rel) { return path.join(__dirname, '..', 'server', 'assets', rel); } });

var heard = { bpm: 128, epoch: 1700000000000, phase: false, confidence: 0.7, source: 'audio' };
var mediaReads = 0, polls = 0;
home.musicPlaying = function (cb) { mediaReads++; cb(true); };
aurorBeat.polled = function () { polls++; };
aurorBeat.beat = function () { return heard; };
var server = http.createServer(routes.handleRequest), port;

function get(url, cb) {
  http.get({ hostname: '127.0.0.1', port: port, path: url }, function (res) {
    var chunks = [];
    res.on('data', function (d) { chunks.push(d); });
    res.on('end', function () { cb(res.statusCode, JSON.parse(Buffer.concat(chunks).toString())); });
  }).on('error', function (e) { throw e; });
}
function setLook(look, next) {
  home.setLook(look, function (r) {
    assert.ok(r.ok, JSON.stringify(r));
    next();
  });
}

var steps = [
  function (next) {
    setLook({ mascots: true, followBeat: true }, function () {
      get('/api/home/look/beat', function (status, r) {
        assert.strictEqual(status, 200);
        assert.deepEqual(r, { ok: true, beat: heard }, 'the beat as lib/auror-beat has it');
        assert.strictEqual(mediaReads, 0, 'no read of the media state');
        assert.strictEqual(polls, 0, 'and no poll: the look every 5 s owns the capture');
        next();
      });
    });
  },
  function (next) {
    setLook({ mascots: true, followBeat: false }, function () {
      get('/api/home/look/beat', function (status, r) {
        assert.strictEqual(status, 200);
        assert.deepEqual(r, { ok: true, beat: null }, 'following the beat off: null');
        next();
      });
    });
  },
  function (next) {
    setLook({ mascots: false, followBeat: true }, function () {
      get('/api/home/look/beat', function (status, r) {
        assert.deepEqual(r, { ok: true, beat: null }, 'mascots off: null');
        assert.strictEqual(mediaReads, 0);
        assert.strictEqual(polls, 0);
        next();
      });
    });
  },
  function (next) {
    setLook({ mascots: true, followBeat: true }, function () {
      get('/api/home/look', function (status, r) {
        assert.strictEqual(r.music, true);
        assert.deepEqual(r.beat, heard, 'the look still carries the beat');
        assert.strictEqual(mediaReads, 1);
        assert.strictEqual(polls, 1, 'and is the poll');
        next();
      });
    });
  }
];

// From the network with a token set, the beat route answers as the look does.
function lanStatus(url, token) {
  var req = new (require('events').EventEmitter)(), status = null;
  req.url = url + (token ? '?k=' + token : '');
  req.method = 'GET';
  req.headers = { host: '192.168.1.131:8080' };
  req.connection = { remoteAddress: '192.168.1.50' };
  req.destroy = function () {};
  routes.handleRequest(req, { writeHead: function (code) { status = code; }, setHeader: function () {}, end: function () {} });
  return status;
}
function lanAuth() {
  routes.init({ config: { allowControl: true, token: 'secret' }, home: home,
    assetPath: function (rel) { return path.join(__dirname, '..', 'server', 'assets', rel); } });
  var look = lanStatus('/api/home/look'), beat = lanStatus('/api/home/look/beat');
  assert.ok(look === 401 || look === 403, 'the look refused without the token: ' + look);
  assert.strictEqual(beat, look, 'and the beat refused the same way');
  assert.strictEqual(lanStatus('/api/home/look/beat', 'secret'), 200, 'with it, answered');
  console.log('  ✓ from the network, the beat route asks for the token as the look does');
}

server.listen(0, '127.0.0.1', function () {
  port = server.address().port;
  (function run() {
    var step = steps.shift();
    if (step) return step(run);
    server.close(function () {
      lanAuth();
      try { fs.readdirSync(dir).forEach(function (f) { fs.unlinkSync(path.join(dir, f)); }); fs.rmdirSync(dir); } catch (e) {}
      console.log('ALL test-auror-look-beat.js assertions passed!');
    });
  })();
});
