/* AUROR's photos behind Home (lib/auror-gallery), through the real HTTP
 * routes: the phone's page needs its code, takes only valid JPEGs, and a
 * photo chosen stands in for the wallpapers in what the view is told.
 * Strict ES5: also runs on node 0.10. */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var home = require('../server/lib/home');
var routes = require('../server/lib/routes');

var dir = path.join(os.tmpdir(), 'auror-gallery-' + process.pid);
var jpeg = fs.readFileSync(path.join(__dirname, 'fixtures/home-wallpaper.jpg'));
fs.mkdirSync(dir);
var clock = 0;
home.init({ stateDir: dir, webosVersion: '9.2.2', port: 8080, now: function () { return 1700000000000 + clock; } });
routes.init({ config: { allowControl: true }, home: home,
  assetPath: function (rel) { return path.join(__dirname, '..', 'server', 'assets', rel); } });
var server = http.createServer(routes.handleRequest), port, code;

function request(method, url, body, type, cb) {
  var h = { 'Content-Length': body ? body.length : 0 };
  if (type) h['Content-Type'] = type;
  var req = http.request({ hostname: '127.0.0.1', port: port, method: method, path: url, headers: h }, function (res) {
    var chunks = [];
    res.on('data', function (d) { chunks.push(d); });
    res.on('end', function () {
      var buf = Buffer.concat(chunks), json = null;
      try { json = JSON.parse(buf); } catch (e) {}
      cb(res.statusCode, json, buf);
    });
  });
  req.on('error', function (e) { throw e; });
  req.end(body || undefined);
}
function post(url, obj, cb) { request('POST', url + (url.indexOf('?') === -1 ? '?' : '&') + 'c=' + code, new Buffer(JSON.stringify(obj)), 'application/json', cb); }
function upload(query, data, cb) { request('POST', '/photos/upload?c=' + code + '&' + query, data, 'image/jpeg', cb); }

var ids = [];
var steps = [
  function (next) {
    request('GET', '/photos/list?c=nope', null, null, function (status, r) {
      assert.strictEqual(status, 403);
      assert.ok(r.expired, 'without the code from the TV, nothing');
      code = /c=([0-9a-f]+)/.exec(home.gallery.pair('http://tv:8080').url)[1];
      assert.strictEqual(/c=([0-9a-f]+)/.exec(home.gallery.pair('http://tv:8080').url)[1], code, 'the code shown stays the same');
      request('GET', '/photos', null, null, function (pageStatus, json, page) {
        assert.strictEqual(pageStatus, 200);
        assert.ok(/photosphone\.title/.test(page.toString()), 'the page itself needs no code');
        next();
      });
    });
  },
  function (next) {
    upload('kind=photo', new Buffer('ffd8ffc00008080001000101ffd9', 'hex'), function (status) {
      assert.strictEqual(status, 400, 'not a JPEG that decodes');
      upload('kind=photo', jpeg, function (s1, r1) {
        assert.strictEqual(s1, 200, JSON.stringify(r1));
        ids.push(r1.id);
        upload('kind=thumb&id=' + r1.id, jpeg, function (s2) {
          assert.strictEqual(s2, 200);
          clock += 1000;
          upload('kind=photo', jpeg, function (s3, r3) {
            assert.strictEqual(s3, 200);
            ids.push(r3.id);
            upload('kind=thumb&id=nothere-0000', jpeg, function (s4) {
              assert.strictEqual(s4, 404, 'a small copy only of a photo there');
              next();
            });
          });
        });
      });
    });
  },
  function (next) {
    request('GET', '/photos/list?c=' + code, null, null, function (status, r) {
      assert.strictEqual(status, 200);
      assert.deepEqual(r.ids, ids, 'oldest first');
      assert.strictEqual(r.mode, 'off');
      assert.strictEqual(r.shown, null);
      assert.strictEqual(home.beat().wallpapers.src, undefined, 'off: Glasshouse\'s wallpapers');
      next();
    });
  },
  function (next) {
    post('/photos/use', { id: ids[0] }, function (status, r) {
      assert.strictEqual(status, 200);
      assert.strictEqual(r.mode, 'one');
      assert.strictEqual(r.shown, ids[0]);
      var wall = home.beat().wallpapers;
      assert.ok(wall.available && wall.slots.night);
      assert.ok(wall.src.indexOf('/api/home/photo?id=' + ids[0]) === 0, 'the view is told where the photo is');
      request('GET', '/api/home/photo?id=' + ids[0] + '&thumb=1', null, null, function (s2, json, buf) {
        assert.strictEqual(s2, 200);
        assert.deepEqual(buf, jpeg);
        request('GET', '/api/home/photo?id=../home', null, null, function (s3) {
          assert.strictEqual(s3, 404);
          next();
        });
      });
    });
  },
  function (next) {
    request('POST', '/api/home/gallery', new Buffer(JSON.stringify({ mode: 'rotate', every: 15 })), 'application/json', function (status, r) {
      assert.strictEqual(status, 200);
      assert.strictEqual(r.every, 15);
      assert.ok(r.wallpapers && r.wallpapers.src, 'the view gets the new background at once');
      var first = home.beat().wallpapers.src;
      clock += 15 * 60000;
      assert.notStrictEqual(home.beat().wallpapers.src, first, 'in turn, the next one a quarter of an hour on');
      request('POST', '/api/home/gallery', new Buffer('{"every":7}'), 'application/json', function (s2, r2) {
        assert.strictEqual(r2.ok, false, 'only the intervals offered');
        next();
      });
    });
  },
  function (next) {
    post('/photos/remove', { id: ids[0] }, function (status, r) {
      assert.strictEqual(status, 200);
      assert.deepEqual(r.ids, [ids[1]]);
      assert.ok(!fs.existsSync(path.join(dir, 'auror-photos', ids[0] + '.thumb.jpg')));
      // As the server starts again: the settings are kept.
      home.init({ stateDir: dir, webosVersion: '9.2.2', port: 8080 });
      assert.strictEqual(home.gallery.status().mode, 'rotate');
      request('GET', '/photos/list?c=' + code, null, null, function (s2) {
        assert.strictEqual(s2, 403, 'a restart forgets the codes');
        next();
      });
    });
  }
];

server.listen(0, '127.0.0.1', function () {
  port = server.address().port;
  (function run() {
    var step = steps.shift();
    if (step) return step(run);
    server.close(function () {
      console.log('ALL test-auror-gallery.js assertions passed!');
    });
  })();
});
