/* Glasshouse Home's Jellyfin: linking from a phone with a one-time code, the
 * Top Shelf's states, the older API paths and the picture proxy.
 * Strict ES5: also runs on node 0.10. */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var jf = require('../server/lib/home-jellyfin');

var KEY = '0123456789abcdef0123456789abcdef';
var dir = fs.mkdtempSync ? fs.mkdtempSync(path.join(os.tmpdir(), 'gh-jf-')) : path.join(os.tmpdir(), 'gh-jf-' + Date.now());
if (!fs.existsSync(dir)) fs.mkdirSync(dir);
var clock = 1000000;
jf.init(dir, function () { return clock; });

var fake = { users: [{ Id: 'u1', Name: 'Marco' }, { Id: 'u2', Name: 'Ospite' }], resume: [], latest: [], legacyOnly: false, hits: [] };
var server = http.createServer(function (req, res) {
  fake.hits.push(req.url);
  if (req.headers.authorization !== 'MediaBrowser Client="Glasshouse", Device="LG TV", DeviceId="glasshouse-home", Version="1", Token="' + KEY + '"') {
    res.writeHead(401); return res.end();
  }
  function json(o) { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); }
  if (req.url === '/Users') return json(fake.users);
  if (/^\/UserItems\/Resume\?/.test(req.url) || /^\/Items\/Latest\?/.test(req.url)) {
    if (fake.legacyOnly) { res.writeHead(404); return res.end(); }
    return /Resume/.test(req.url) ? json({ Items: fake.resume }) : json(fake.latest);
  }
  if (/^\/Users\/u1\/Items\/Resume\?/.test(req.url)) return json({ Items: fake.resume });
  if (/^\/Users\/u1\/Items\/Latest\?/.test(req.url)) return json(fake.latest);
  if (/^\/Items\/[0-9a-f]{32}\/Images\/Primary\?/.test(req.url)) { res.writeHead(200, { 'Content-Type': 'image/jpeg' }); return res.end('JPEG'); }
  res.writeHead(404); res.end();
});

var steps = [], current = 0;
function step(name, fn) { steps.push({ name: name, fn: fn }); }
function next() {
  var s = steps[current++];
  if (!s) { server.close(); console.log('\nALL test-home-jellyfin.js assertions passed!'); return; }
  s.fn(function () { console.log('  ok  ' + s.name); next(); });
}

var base, code;

step('a code is needed, and lasts ten minutes', function (done) {
  assert.strictEqual(jf.pair(null).ok, false, 'no address a phone can reach, no code');
  var p = jf.pair('http://192.168.1.50:8080');
  assert.ok(p.ok);
  code = /c=([0-9a-f]{16})$/.exec(p.url)[1];
  assert.ok(jf.codeValid(code));
  jf.link({ c: 'feedfeedfeedfeed', server: base, key: KEY }, function (r) {
    assert.strictEqual(r.expired, true);
    jf.link({ c: code, check: true }, function (r2) {
      assert.strictEqual(r2.valid, true);
      done();
    });
  });
});

step('details are checked before they are kept', function (done) {
  jf.link({ c: code, server: '', key: KEY }, function (r) {
    assert.strictEqual(r.ok, false);
    jf.link({ c: code, server: base, key: 'short' }, function (r2) {
      assert.strictEqual(r2.ok, false, 'a key is 32 hex digits');
      jf.link({ c: code, server: base, key: 'ffffffffffffffffffffffffffffffff' }, function (r3) {
        assert.strictEqual(r3.ok, false, 'a refused key');
        assert.strictEqual(jf.status().configured, false);
        done();
      });
    });
  });
});

step('with two users the phone is asked which, then it is linked and the code is spent', function (done) {
  jf.link({ c: code, server: base.replace('http://', ''), key: KEY }, function (r) {
    assert.strictEqual(r.needUser, true);
    assert.deepEqual(r.users.map(function (u) { return u.name; }), ['Marco', 'Ospite']);
    jf.link({ c: code, server: base.replace('http://', ''), key: KEY, user: 'u1' }, function (r2) {
      assert.strictEqual(r2.ok, true);
      assert.strictEqual(r2.user, 'Marco');
      assert.strictEqual(jf.codeValid(code), false, 'a code links once');
      var st = jf.status();
      assert.strictEqual(st.configured, true);
      assert.strictEqual(st.user, 'Marco');
      assert.strictEqual(st.key, undefined, 'the key is never sent back');
      assert.strictEqual(fs.statSync(path.join(dir, 'jellyfin.json')).mode & 511, 384);
      done();
    });
  });
});

step('nothing being watched: the shelf shows what was added last', function (done) {
  fake.latest = [{ Id: 'aa', Name: 'Dune', Type: 'Movie', ProductionYear: 2021, ImageTags: {}, BackdropImageTags: ['b1'] }];
  jf.shelf(function (r) {
    assert.strictEqual(r.state, 'latest');
    assert.strictEqual(r.items[0].title, 'Dune');
    assert.strictEqual(r.items[0].kind, 'movie');
    assert.ok(/type=Backdrop&tag=b1$/.test(r.items[0].image));
    done();
  });
});

step('something being watched comes first, and is kept a minute', function (done) {
  fake.resume = [{ Id: 'ee', Name: 'Pilot', SeriesName: 'Severance', Type: 'Episode', ParentIndexNumber: 1, IndexNumber: 1,
    UserData: { PlayedPercentage: 41.6 }, ImageTags: { Primary: 'p1' } }];
  jf.shelf(function (cached) {
    assert.strictEqual(cached.state, 'latest', 'still the cached answer');
    clock += 61000;
    jf.shelf(function (r) {
      assert.strictEqual(r.state, 'resume');
      var c = r.items[0];
      assert.strictEqual(c.title, 'Severance');
      assert.strictEqual(c.season, 1);
      assert.strictEqual(c.episode, 1);
      assert.strictEqual(c.name, 'Pilot');
      assert.strictEqual(c.progress, 42);
      done();
    });
  });
});

step('a server from before 10.9 is asked on its older paths', function (done) {
  fake.legacyOnly = true;
  fake.hits = [];
  clock += 61000;
  jf.shelf(function (r) {
    assert.strictEqual(r.state, 'resume');
    assert.ok(fake.hits.some(function (u) { return /^\/Users\/u1\/Items\/Resume/.test(u); }));
    fake.legacyOnly = false;
    done();
  });
});

step('pictures are proxied with the key, and only well-formed ones', function (done) {
  var res = { status: 0, body: '', headers: null,
    writeHead: function (s, h) { this.status = s; this.headers = h; },
    end: function (b) { this.body += b || ''; if (this.onEnd) this.onEnd(); },
    write: function (b) { this.body += b; return true; },
    on: function () { return this; }, once: function () { return this; }, emit: function () { return true; },
    removeListener: function () { return this; } };
  jf.image({ id: '../etc', type: 'Primary', tag: 'p1' }, res);
  assert.strictEqual(res.status, 404);
  var pass = new (require('stream').PassThrough)();
  var chunks = [];
  pass.writeHead = function (s, h) { pass.status = s; pass.headers = h; };
  pass.on('data', function (d) { chunks.push(d); });
  pass.on('end', function () {
    assert.strictEqual(pass.status, 200);
    assert.strictEqual(pass.headers['Content-Type'], 'image/jpeg');
    assert.strictEqual(Buffer.concat(chunks).toString(), 'JPEG');
    done();
  });
  jf.image({ id: '0123456789abcdef0123456789abcdef', type: 'Primary', tag: 'p1' }, pass);
});

step('a server that does not answer is offline, and unlinking forgets it', function (done) {
  server.close(function () {
    clock += 61000;
    jf.shelf(function (r) {
      assert.strictEqual(r.state, 'offline');
      jf.forget(function () {
        assert.strictEqual(jf.status().configured, false);
        assert.strictEqual(fs.existsSync(path.join(dir, 'jellyfin.json')), false);
        jf.shelf(function (r2) {
          assert.strictEqual(r2.state, 'off');
          server = { close: function () {} };
          done();
        });
      });
    });
  });
});

server.listen(0, '127.0.0.1', function () {
  base = 'http://127.0.0.1:' + server.address().port;
  next();
});
