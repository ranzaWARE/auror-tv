/* Home Assistant on AUROR's Home (lib/auror-ha), against a stand-in Home
 * Assistant: linked with a live code and a token it takes, a first pick
 * before anything is chosen, then only the entities chosen shown and acted
 * on, with the services each kind has, cameras passed through, and Home
 * Assistant's own dashboard opened in the TV's browser.
 * Strict ES5: also runs on node 0.10. */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var http = require('http');
var ha = require('../server/lib/auror-ha');

var TOKEN = 'eyJhbGciOiJIUzI1NiJ9.eyJpc3MiOiJ0ZXN0In0.c2lnbmF0dXJlLXN0YW5kLWlu';
var dir = path.join(os.tmpdir(), 'auror-ha-' + process.pid);
fs.mkdirSync(dir);

var STATES = [
  { entity_id: 'climate.living', state: 'heat', attributes: { friendly_name: 'Living room', current_temperature: 20.5, temperature: 21, min_temp: 7, max_temp: 30, target_temp_step: 0.5, hvac_modes: ['off', 'heat', 'auto'], hvac_action: 'heating' } },
  { entity_id: 'light.kitchen', state: 'off', attributes: { friendly_name: 'Kitchen' } },
  { entity_id: 'light.desk', state: 'on', attributes: { friendly_name: 'Desk', brightness: 128 } },
  { entity_id: 'switch.tv_plug', state: 'on', attributes: { friendly_name: 'TV plug' } },
  { entity_id: 'cover.garage', state: 'closed', attributes: { friendly_name: 'Garage', current_position: 0 } },
  { entity_id: 'scene.movie', state: 'scening', attributes: { friendly_name: 'Movie night' } },
  { entity_id: 'sensor.outside', state: '12.4', attributes: { friendly_name: 'Outside', unit_of_measurement: '°C', device_class: 'temperature' } },
  { entity_id: 'sensor.uptime', state: '3', attributes: { friendly_name: 'Uptime', device_class: 'duration' } },
  { entity_id: 'camera.door', state: 'idle', attributes: { friendly_name: 'Door' } },
  { entity_id: 'lock.front', state: 'locked', attributes: { friendly_name: 'Front door' } },
  { entity_id: 'person.marco', state: 'home', attributes: { friendly_name: 'Marco' } }
];

var services = [];
var stand = http.createServer(function (req, res) {
  function json(code, body) { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(body)); }
  if (req.headers.authorization !== 'Bearer ' + TOKEN) return json(401, { message: 'Invalid access token' });
  var sent = '';
  req.on('data', function (d) { sent += d; });
  req.on('end', function () {
    var u = req.url;
    if (u === '/api/config') return json(200, { location_name: 'Casa', version: '2026.10.3' });
    if (u === '/api/states') return json(200, STATES);
    var service = /^\/api\/services\/([a-z_]+)\/([a-z_]+)$/.exec(u);
    if (service && req.method === 'POST') {
      services.push({ service: service[1] + '/' + service[2], data: JSON.parse(sent) });
      return json(200, []);
    }
    if (u === '/api/camera_proxy/camera.door') {
      res.writeHead(200, { 'Content-Type': 'image/jpeg' });
      return res.end(new Buffer('still-frame'));
    }
    json(404, { message: 'Not found' });
  });
});

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

var server, launched = [], steps = [];
function step(name, fn) { steps.push([name, fn]); }
function codeOf(r) { return /c=([0-9a-f]+)/.exec(r.url)[1]; }
function ids(r) { return r.entities.map(function (e) { return e.id; }); }

step('not linked, it says so; a stale code or a refused token keeps nothing', function (done) {
  assert.deepEqual(ha.status(), { ok: true, configured: false });
  ha.link({ c: 'nope', server: server, token: TOKEN }, function (r) {
    assert.ok(r.expired);
    var code = codeOf(ha.pair('http://tv:8080'));
    ha.link({ c: code, server: server, token: TOKEN.replace(/.$/, 'x') }, function (r2) {
      assert.strictEqual(r2.ok, false);
      assert.ok(/refused/.test(r2.error));
      ha.link({ c: code, server: server, token: 'short' }, function (r3) {
        assert.ok(/long-lived/.test(r3.error));
        assert.ok(!fs.existsSync(path.join(dir, 'auror-ha.json')));
        done();
      });
    });
  });
});

step('linked: kept readable by root only, with the home\'s name; the code stays for choosing', function (done) {
  var code = codeOf(ha.pair('http://tv:8080'));
  assert.strictEqual(codeOf(ha.pair('http://tv:8080')), code, 'one code while it is used');
  ha.link({ c: code, server: server.replace('http://', '') + '/lovelace/0', token: TOKEN }, function (r) {
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.place, 'Casa');
    var kept = JSON.parse(fs.readFileSync(path.join(dir, 'auror-ha.json'), 'utf8'));
    assert.strictEqual(kept.server, server, 'http:// assumed and the dashboard\'s path taken off');
    assert.strictEqual(kept.chosen, null);
    assert.strictEqual((fs.statSync(path.join(dir, 'auror-ha.json')).mode & 511).toString(8), '600');
    assert.deepEqual(ha.status(), { ok: true, configured: true, server: server.replace('http://', ''), place: 'Casa', chosen: null });
    ha.link({ c: code, check: true }, function (again) {
      assert.ok(again.linked, 'the same code goes on to choosing');
      done();
    });
  });
});

step('before anything is chosen, a first pick: no locks, no odd sensors, the panel\'s order', function (done) {
  ha.states(function (r) {
    assert.ok(r.ok, r.error);
    assert.strictEqual(r.chosen, false);
    assert.deepEqual(ids(r), ['climate.living', 'light.desk', 'light.kitchen', 'cover.garage', 'scene.movie', 'sensor.outside', 'camera.door']);
    assert.deepEqual(r.entities[0], { id: 'climate.living', group: 'climate', domain: 'climate', name: 'Living room', state: 'heat',
      current: 20.5, target: 21, min: 7, max: 30, step: 0.5, modes: ['off', 'heat', 'auto'], action: 'heating', humidity: null });
    assert.strictEqual(r.entities[1].brightness, 50);
    assert.strictEqual(r.entities[5].unit, '°C');
    done();
  });
});

step('the phone lists every entity the panel could show, and saves a choice', function (done) {
  var code = codeOf(ha.pair('http://tv:8080'));
  ha.entities(code, function (r) {
    assert.ok(r.ok, r.error);
    assert.ok(ids(r).indexOf('lock.front') === -1 && ids(r).indexOf('person.marco') === -1);
    assert.ok(ids(r).indexOf('switch.tv_plug') !== -1);
    var desk = r.entities.filter(function (e) { return e.id === 'light.desk'; })[0];
    assert.deepEqual(desk, { id: 'light.desk', group: 'power', name: 'Desk', shown: true });
    ha.choose({ c: code, ids: ['climate.living', 'switch.tv_plug', 'camera.door', 'lock.front', '../etc'] }, function (c) {
      assert.ok(c.ok, c.error);
      assert.strictEqual(c.chosen, 3, 'a lock and a bad id are not kept');
      ha.choose({ c: 'stale', ids: [] }, function (bad) {
        assert.ok(bad.expired);
        ha.states(function (s) {
          assert.deepEqual(ids(s), ['climate.living', 'switch.tv_plug', 'camera.door']);
          done();
        });
      });
    });
  });
});

step('acting: the services each kind has, on chosen entities only', function (done) {
  ha.act({ id: 'switch.tv_plug', action: 'toggle' }, function (r) {
    assert.ok(r.ok, r.error);
    assert.deepEqual(services.pop(), { service: 'homeassistant/toggle', data: { entity_id: 'switch.tv_plug' } });
    ha.act({ id: 'light.kitchen', action: 'toggle' }, function (r2) {
      assert.strictEqual(r2.ok, false, 'not chosen');
      ha.act({ id: 'lock.front', action: 'toggle' }, function (r3) {
        assert.strictEqual(r3.ok, false, 'not a kind the TV acts on');
        ha.act({ id: 'climate.living', action: 'toggle' }, function (r4) {
          assert.strictEqual(r4.ok, false, 'heating is set, not toggled');
          assert.strictEqual(services.length, 0);
          done();
        });
      });
    });
  });
});

step('heating: a temperature in range, a mode it has', function (done) {
  ha.act({ id: 'climate.living', action: 'temperature', value: 22.25 }, function (r) {
    assert.ok(r.ok, r.error);
    assert.deepEqual(services.pop(), { service: 'climate/set_temperature', data: { entity_id: 'climate.living', temperature: 22.3 } });
    ha.act({ id: 'climate.living', action: 'temperature', value: 45 }, function (r2) {
      assert.ok(/range/.test(r2.error));
      ha.act({ id: 'climate.living', action: 'mode', value: 'cool' }, function (r3) {
        assert.ok(/mode/.test(r3.error));
        ha.act({ id: 'climate.living', action: 'mode', value: 'auto' }, function (r4) {
          assert.ok(r4.ok, r4.error);
          assert.deepEqual(services.pop(), { service: 'climate/set_hvac_mode', data: { entity_id: 'climate.living', hvac_mode: 'auto' } });
          assert.strictEqual(services.length, 0);
          done();
        });
      });
    });
  });
});

step('a chosen camera passes through; any other is refused', function (done) {
  ha.camera({ id: 'camera.door' }, fakeRes(function (code, headers, body) {
    assert.strictEqual(code, 200);
    assert.strictEqual(headers['Content-Type'], 'image/jpeg');
    assert.strictEqual(body, 'still-frame');
    ha.camera({ id: 'camera.garden' }, fakeRes(function (code2) {
      assert.strictEqual(code2, 404);
      done();
    }));
  }));
});

step('Home Assistant\'s own dashboard opens in the TV\'s browser', function (done) {
  ha.openDashboard(function (r) {
    assert.ok(r.ok);
    assert.deepEqual(launched, [server + '/']);
    done();
  });
});

step('linked again to the same server, the choice is kept; unlinking removes the token', function (done) {
  var code = codeOf(ha.pair('http://tv:8080'));
  ha.link({ c: code, server: server, token: TOKEN }, function (r) {
    assert.ok(r.ok, r.error);
    assert.strictEqual(ha.status().chosen, 3);
    ha.forget(function (f) {
      assert.strictEqual(f.configured, false);
      assert.ok(!fs.existsSync(path.join(dir, 'auror-ha.json')));
      ha.act({ id: 'switch.tv_plug', action: 'toggle' }, function (r2) {
        assert.strictEqual(r2.ok, false);
        done();
      });
    });
  });
});

stand.listen(0, '127.0.0.1', function () {
  server = 'http://127.0.0.1:' + stand.address().port;
  ha.init({ stateDir: dir, control: function (cmd, value, cb) { launched.push(value); cb({ ok: cmd === 'launchUrl' }); } });
  (function next(i) {
    if (i >= steps.length) {
      stand.close();
      console.log('ALL test-auror-ha.js assertions passed!');
      return;
    }
    steps[i][1](function () {
      console.log('  ✓ ' + steps[i][0]);
      next(i + 1);
    });
  })(0);
});
