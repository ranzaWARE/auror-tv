/* Immich's albums on AUROR's Home (lib/auror-immich), against a stand-in
 * Immich: linked once with a live code and a key it takes, the albums and an
 * album's contents from the timeline or, from Immich 1, with the album, and
 * pictures and videos passed through with the key added here.
 * Strict ES5: also runs on node 0.10. */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var immich = require('../server/lib/auror-immich');

var KEY = 'Zk1u7Pq0rS3tUv5wXy7zAb9cDe1fGh3iJk5lMn7oPq';
var A1 = '11111111-1111-4111-8111-111111111111', A2 = '22222222-2222-4222-8222-222222222222';
var P1 = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', P2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', V1 = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
var dir = path.join(os.tmpdir(), 'auror-immich-' + process.pid);
fs.mkdirSync(dir);

var asked = [], old = false, noMemories = false, randomAsked = null;
var stand = http.createServer(function (req, res) {
  asked.push(req.method + ' ' + req.url + (req.headers.range ? ' ' + req.headers.range : ''));
  function json(code, body) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
  if (req.headers['x-api-key'] !== KEY) return json(401, { message: 'Invalid API key' });
  var u = req.url;
  if (u === '/api/albums') {
    return json(200, [
      { id: A1, albumName: 'Lago', assetCount: 3, albumThumbnailAssetId: P1, startDate: '2026-07-12T10:00:00.000Z', endDate: '2026-07-26T18:00:00.000Z', shared: false, lastModifiedAssetTimestamp: '2026-07-27T00:00:00.000Z' },
      { id: A2, albumName: 'Neve', assetCount: 1, albumThumbnailAssetId: null, startDate: '2026-02-01T00:00:00.000Z', endDate: '2026-02-01T00:00:00.000Z', shared: true, lastModifiedAssetTimestamp: '2026-09-01T00:00:00.000Z' },
      { id: 'not-a-uuid', albumName: 'Broken' }
    ]);
  }
  if (u === '/api/users/me') return json(200, { name: 'Marco' });
  if (/^\/api\/memories\?for=2026-10-27&type=on_this_day$/.test(u)) {
    if (noMemories) return json(403, { message: 'Missing required permission: memory.read' });
    return json(200, [
      { type: 'on_this_day', data: { year: 2023 }, assets: [{ id: P1, type: 'IMAGE', exifInfo: { city: 'Garda' } }] },
      { type: 'on_this_day', data: { year: 2025 }, assets: [{ id: V1, type: 'VIDEO' }, { id: P2, type: 'IMAGE', exifInfo: { country: 'Italia' } }] },
      { type: 'on_this_day', data: { year: 2020 }, assets: [{ id: V1, type: 'VIDEO' }] }
    ]);
  }
  if (u === '/api/search/random' && req.method === 'POST') {
    var sent = '';
    req.on('data', function (d) { sent += d; });
    return req.on('end', function () {
      randomAsked = JSON.parse(sent);
      json(200, [{ id: P1, type: 'IMAGE', localDateTime: '2024-05-01T10:00:00.000Z', exifInfo: { city: 'Verona' } }, { id: V1, type: 'VIDEO' }]);
    });
  }
  if (u === '/api/albums/' + A1) {
    var info = { id: A1, albumName: 'Lago', order: 'desc' };
    if (old) info.assets = [
      { id: P2, type: 'IMAGE', fileCreatedAt: '2026-07-20T10:00:00.000Z', exifInfo: { city: 'Malcesine' } },
      { id: V1, type: 'VIDEO', fileCreatedAt: '2026-07-26T10:00:00.000Z', exifInfo: {} }
    ];
    return json(200, info);
  }
  if (u === '/api/timeline/buckets?albumId=' + A1 + '&order=desc') {
    return json(200, [{ timeBucket: '2026-07-01', count: 3 }]);
  }
  if (u === '/api/timeline/bucket?albumId=' + A1 + '&order=desc&timeBucket=2026-07-01') {
    return json(200, { id: [V1, P2, P1], isImage: [false, true, true], fileCreatedAt: ['2026-07-26T10:00:00.000Z', '2026-07-20T10:00:00.000Z', '2026-07-12T10:00:00.000Z'],
      city: [null, 'Malcesine', 'Garda'], country: ['Italia', 'Italia', 'Italia'] });
  }
  if (u === '/api/assets/' + P1 + '/thumbnail?size=preview') {
    res.writeHead(200, { 'Content-Type': 'image/jpeg' });
    return res.end(new Buffer('jpeg-bytes'));
  }
  if (u === '/api/assets/' + V1 + '/video/playback') {
    if (req.headers.range === 'bytes=4-') {
      res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Range': 'bytes 4-9/10', 'Content-Length': 6 });
      return res.end(new Buffer('video!'));
    }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': 10 });
    return res.end(new Buffer('mp4-video!'));
  }
  json(404, { message: 'Not found' });
});

// What lib/routes hands thumb and video: a response written to here.
function fakeRes(cb) {
  var r = new (require('stream').Writable)();
  var chunks = [];
  r._write = function (c, e, done) { chunks.push(c); done(); };
  r.writeHead = function (code, headers) { r.code = code; r.headers = headers; };
  var end = r.end;
  r.end = function (x) { if (x) chunks.push(new Buffer(x)); end.call(r); };
  r.on('finish', function () { cb(r.code, r.headers, Buffer.concat(chunks).toString()); });
  return r;
}

var server, steps = [];
function step(name, fn) { steps.push([name, fn]); }

step('not linked, it says so; a stale code or a refused key keeps nothing', function (done) {
  assert.deepEqual(immich.status(), { ok: true, configured: false });
  immich.link({ c: 'nope', server: server, key: KEY }, function (r) {
    assert.ok(r.expired);
    var code = /c=([0-9a-f]+)/.exec(immich.pair('http://tv:8080').url)[1];
    immich.link({ c: code, server: server, key: 'WrongKeyWrongKeyWrongKey' }, function (r2) {
      assert.strictEqual(r2.ok, false);
      assert.ok(/refused/.test(r2.error));
      assert.ok(!fs.existsSync(path.join(dir, 'immich.json')));
      done();
    });
  });
});

step('linked with a live code: kept readable by root only, with the user\'s name', function (done) {
  var code = /c=([0-9a-f]+)/.exec(immich.pair('http://tv:8080').url)[1];
  immich.link({ c: code, server: server.replace('http://', '') + '/api/', key: KEY }, function (r) {
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.user, 'Marco');
    assert.strictEqual(r.albums, 3);
    var kept = JSON.parse(fs.readFileSync(path.join(dir, 'immich.json'), 'utf8'));
    assert.strictEqual(kept.server, server, 'http:// assumed and /api taken off');
    assert.strictEqual((fs.statSync(path.join(dir, 'immich.json')).mode & 511).toString(8), '600');
    assert.strictEqual(immich.status().user, 'Marco');
    immich.link({ c: code, server: server, key: KEY }, function (again) {
      assert.ok(again.expired, 'a code links once');
      done();
    });
  });
});

step('the albums: the one added to last first, ids that are not Immich\'s left out', function (done) {
  immich.albums(function (r) {
    assert.ok(r.ok);
    assert.deepEqual(r.albums.map(function (a) { return a.name; }), ['Neve', 'Lago']);
    assert.deepEqual(r.albums[1], { id: A1, name: 'Lago', count: 3, cover: P1, from: '2026-07-12', to: '2026-07-26', shared: false });
    done();
  });
});

step('an album from the timeline, newest first, videos and places marked', function (done) {
  immich.album(A1, function (r) {
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.name, 'Lago');
    assert.deepEqual(r.assets, [
      { id: V1, video: true, date: '2026-07-26', place: 'Italia' },
      { id: P2, video: false, date: '2026-07-20', place: 'Malcesine' },
      { id: P1, video: false, date: '2026-07-12', place: 'Garda' }
    ]);
    var before = asked.length;
    immich.album(A1, function () {
      assert.strictEqual(asked.length, before, 'asked again, it is answered from what was kept');
      immich.album('../../etc', function (bad) {
        assert.strictEqual(bad.ok, false);
        done();
      });
    });
  });
});

step('from Immich 1, the album comes with what is in it', function (done) {
  old = true;
  immich.init(dir);
  var before = asked.length;
  immich.album(A1, function (r) {
    assert.deepEqual(r.assets.map(function (a) { return a.id; }), [V1, P2]);
    assert.strictEqual(r.assets[0].video, true);
    assert.ok(!asked.slice(before).some(function (a) { return /timeline/.test(a); }), 'the timeline is not asked');
    done();
  });
});

step('pictures pass through with the key added; only Immich\'s ids', function (done) {
  immich.thumb({ id: P1, size: 'preview' }, fakeRes(function (code, headers, body) {
    assert.strictEqual(code, 200);
    assert.strictEqual(headers['Content-Type'], 'image/jpeg');
    assert.strictEqual(body, 'jpeg-bytes');
    immich.thumb({ id: P1, size: 'original' }, fakeRes(function (code2) {
      assert.strictEqual(code2, 404, 'only the sizes the view shows');
      done();
    }));
  }));
});

step('a video passes the player\'s range on', function (done) {
  immich.video({ id: V1 }, { headers: { range: 'bytes=4-' } }, fakeRes(function (code, headers, body) {
    assert.strictEqual(code, 206);
    assert.strictEqual(headers['Content-Range'], 'bytes 4-9/10');
    assert.strictEqual(headers['Content-Length'], '6');
    assert.strictEqual(body, 'video!');
    assert.ok(asked.indexOf('GET /api/assets/' + V1 + '/video/playback bytes=4-') !== -1);
    done();
  }));
});

step('this day in years past: the most recent first, photos only, none without memory.read', function (done) {
  immich.memories('2026-10-27', function (r) {
    assert.ok(r.ok);
    assert.deepEqual(r.memories, [
      { year: 2025, count: 2, cover: P2, place: 'Italia' },
      { year: 2023, count: 1, cover: P1, place: 'Garda' }
    ], 'a year with only a video is left out');
    noMemories = true;
    immich.init(dir);
    immich.memories('2026-10-27', function (r2) {
      assert.ok(r2.ok);
      assert.deepEqual(r2.memories, []);
      assert.ok(r2.unavailable);
      done();
    });
  });
});

step('the screen saver: the library at random, or the album chosen, photos only', function (done) {
  old = false;
  immich.saverPhotos(function (r) {
    assert.ok(r.ok, r.error);
    assert.deepEqual(r.items, [{ id: P1, date: '2024-05-01', place: 'Verona' }]);
    assert.strictEqual(randomAsked.type, 'IMAGE');
    immich.setSaverAlbum('nope', function (bad) {
      assert.strictEqual(bad.ok, false);
      immich.setSaverAlbum(A1, function (st) {
        assert.strictEqual(st.saverAlbum, A1);
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'immich.json'), 'utf8')).key, KEY, 'the key is kept with it');
        immich.saverPhotos(function (r2) {
          assert.deepEqual(r2.items.map(function (x) { return x.id; }).sort(), [P1, P2].sort());
          done();
        });
      });
    });
  });
});

step('unlinking removes the key', function (done) {
  immich.forget(function (r) {
    assert.strictEqual(r.configured, false);
    assert.ok(!fs.existsSync(path.join(dir, 'immich.json')));
    done();
  });
});

stand.listen(0, '127.0.0.1', function () {
  server = 'http://127.0.0.1:' + stand.address().port;
  immich.init(dir);
  (function next(i) {
    if (i >= steps.length) {
      stand.close();
      console.log('ALL test-auror-immich.js assertions passed!');
      return;
    }
    steps[i][1](function () {
      console.log('  ✓ ' + steps[i][0]);
      next(i + 1);
    });
  })(0);
});
