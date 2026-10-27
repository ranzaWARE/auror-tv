/* AUROR's search: titles from TMDB with where they are in Italy, the
 * library's own from Jellyfin, offered on the apps the TV has, and the TMDB
 * key linked from a phone. Strict ES5: also runs on node 0.10. */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var search = require('../server/lib/auror-search');

var KEY = '0123456789abcdef0123456789abcdef';
var dir = fs.mkdtempSync ? fs.mkdtempSync(path.join(os.tmpdir(), 'auror-search-')) : path.join(os.tmpdir(), 'auror-search-' + process.pid);
try { fs.mkdirSync(dir); } catch (e) {}

var asked, launched, library, tmdbDown;
var APPS = [
  { id: 'netflix', title: 'Netflix', icon: '/x/n.png' },
  { id: 'amazon', title: 'Prime Video', icon: '' },
  { id: 'org.jellyfin.webos', title: 'Jellyfin', icon: '/x/j.png' }
];
var TITLES = {
  '/movie/10': { id: 10, title: 'Dune', original_title: 'Dune', release_date: '2021-09-15', runtime: 155, genres: [{ name: 'Fantascienza' }],
    backdrop_path: '/d.jpg', 'watch/providers': { results: { IT: {
      flatrate: [{ provider_name: 'Netflix' }, { provider_name: 'NOW' }],
      rent: [{ provider_name: 'Apple TV' }, { provider_name: 'Netflix' }], buy: [{ provider_name: 'Apple TV' }] } } } },
  '/tv/20': { id: 20, name: 'Dune: Prophecy', original_name: 'Dune: Prophecy', first_air_date: '2024-11-17', episode_run_time: [60],
    poster_path: '/p.jpg', 'watch/providers': { results: { IT: { flatrate: [{ provider_name: 'Amazon Prime Video with Ads' }] } } } },
  '/movie/30': { id: 30, title: 'Dune (1984)', release_date: '1984-12-14', 'watch/providers': { results: { US: { flatrate: [{ provider_name: 'Max' }] } } } }
};
function getJson(url, cb) {
  asked.push(url);
  var u = url.replace('https://api.themoviedb.org/3', '');
  if (tmdbDown) return setImmediate(function () { cb(new Error('offline')); });
  assert.ok(/[?&]api_key=0123456789abcdef0123456789abcdef(&|$)/.test(u), 'the key goes with every request');
  setImmediate(function () {
    if (/^\/configuration\?/.test(u)) return cb(null, { images: {} });
    if (/^\/search\/multi\?/.test(u)) {
      assert.ok(/language=it-IT/.test(u) && /region=IT/.test(u));
      return cb(null, { results: [{ media_type: 'movie', id: 10 }, { media_type: 'person', id: 99 }, { media_type: 'tv', id: 20 }, { media_type: 'movie', id: 30 }] });
    }
    var m = /^(\/(?:movie|tv)\/\d+)\?/.exec(u);
    if (m && TITLES[m[1]]) return cb(null, TITLES[m[1]]);
    cb(new Error('not found'));
  });
}
var jellyfin = { search: function (q, cb) { setImmediate(function () { cb(library); }); } };

function setUp() {
  asked = []; launched = []; tmdbDown = false;
  library = [
    { title: 'Dune', kind: 'film', year: 2021, minutes: 155, genre: 'Sci-Fi', tmdb: '10', image: '/api/home/jellyfin/image?id=a' },
    { title: 'Il mio film di casa', kind: 'film', year: 2019, minutes: 90, genre: null, tmdb: null, image: null }
  ];
  search.init({ stateDir: dir, getJson: getJson, jellyfin: jellyfin, now: Date.now,
    apps: function (cb) { cb(APPS); },
    launch: function (id, params, cb) { launched.push(id); cb({ ok: true }); } });
}

var steps = [];
function step(name, fn) { steps.push([name, fn]); }

step('without a TMDB key, only the library is searched', function (done) {
  try { fs.unlinkSync(path.join(dir, 'tmdb.json')); } catch (e) {}
  setUp();
  search.find('dune', function (r) {
    assert.ok(r.ok);
    assert.strictEqual(asked.length, 0, 'TMDB is not asked');
    assert.strictEqual(r.tmdb, false);
    assert.deepEqual(r.results.map(function (h) { return h.title; }), ['Dune', 'Il mio film di casa']);
    assert.deepEqual(r.results[0].apps.map(function (a) { return a.id; }), ['org.jellyfin.webos']);
    done();
  });
});

step('the key is tried before it is kept, and only with a live code', function (done) {
  setUp();
  search.link({ c: 'nope', key: KEY }, function (r) {
    assert.ok(r.expired);
    var code = /c=([0-9a-f]+)/.exec(search.pair('http://tv:8080').url)[1];
    search.link({ c: code, key: 'short' }, function (r2) {
      assert.strictEqual(r2.ok, false);
      search.link({ c: code, key: KEY }, function (r3) {
        assert.ok(r3.ok);
        assert.strictEqual(JSON.parse(fs.readFileSync(path.join(dir, 'tmdb.json'), 'utf8')).key, KEY);
        assert.strictEqual(search.status().configured, true);
        done();
      });
    });
  });
});

step('titles come with the apps here, the services not here, and rent or buy', function (done) {
  setUp();
  search.find('dune', function (r) {
    assert.ok(r.ok && r.tmdb);
    var titles = r.results.map(function (h) { return h.title; });
    // The library's own first, then what is to watch here; one not in Italy is counted.
    assert.deepEqual(titles, ['Il mio film di casa', 'Dune', 'Dune: Prophecy']);
    assert.strictEqual(r.elsewhere, 1);
    var dune = r.results[1];
    assert.deepEqual(dune.apps.map(function (a) { return a.id; }), ['org.jellyfin.webos', 'netflix'], 'Jellyfin by its TMDB id, and Netflix');
    assert.deepEqual(dune.also, ['NOW']);
    assert.deepEqual(dune.rent, ['Apple TV'], 'a service that streams it is not named again to rent');
    assert.deepEqual(dune.buy, ['Apple TV']);
    assert.strictEqual(dune.minutes, 155);
    assert.strictEqual(dune.poster, 'https://image.tmdb.org/t/p/w780/d.jpg');
    assert.deepEqual(r.results[2].apps.map(function (a) { return a.id; }), ['amazon'], 'Prime Video with Ads is the Prime Video app');
    assert.strictEqual(r.results[2].kind, 'series');
    var before = asked.length;
    search.find('Dune', function () {
      assert.strictEqual(asked.length, before, 'asked again, it is answered from what was kept');
      done();
    });
  });
});

step('only an app the last search offered for that title opens, at its start', function (done) {
  setUp();
  search.find('dune', function (r) {
    var dune = r.results[1];
    search.open({ id: dune.id, app: 'amazon' }, function (no) {
      assert.strictEqual(no.ok, false);
      search.open({ id: dune.id, app: 'netflix' }, function (yes) {
        assert.ok(yes.ok);
        assert.deepEqual(launched, ['netflix']);
        done();
      });
    });
  });
});

step('TMDB not answering still gives the library', function (done) {
  setUp();
  tmdbDown = true;
  search.find('altro', function (r) {
    assert.ok(r.ok);
    assert.deepEqual(r.results.map(function (h) { return h.title; }), ['Dune', 'Il mio film di casa']);
    library = null;
    search.find('altro ancora', function (r2) {
      assert.strictEqual(r2.ok, false, 'with neither, it says so');
      assert.strictEqual(search.blocked(), null, 'LG is never asked, so nothing blocks it');
      done();
    });
  });
});

step('unlinking removes the key', function (done) {
  setUp();
  search.forget(function (r) {
    assert.strictEqual(r.configured, false);
    assert.ok(!fs.existsSync(path.join(dir, 'tmdb.json')));
    done();
  });
});

(function next(i) {
  if (i >= steps.length) {
    console.log('ALL test-auror-search.js assertions passed!');
    return;
  }
  steps[i][1](function () {
    console.log('  ✓ ' + steps[i][0]);
    next(i + 1);
  });
})(0);
