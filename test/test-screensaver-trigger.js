/**
 * Start screen saver asks tvpower plainly first, then without panel care's
 * hold, then opens the screen saver app itself. Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var env = require('./mocks/mock-env').createMockEnv();
env.install();
var screensavers = require('../server/lib/screensavers');
var idlesaver = require('../server/lib/idlesaver');

console.log('Running test-screensaver-trigger.js ...');

/*
 * A TV whose tvpower answers each turnOnScreenSaver from `answers` in turn:
 * 'start' (the screen saver comes up), 'refuse' (back to Active), or
 * 'invalid' (Invalid State change Request).
 */
function tv(answers) {
  var state = { answers: answers.slice(), requests: 0, launched: 0, power: 'Active', calls: [] };
  state.luna = function (uri, params, cb) {
    state.calls.push({ uri: uri, params: params });
    if (/getPowerState$/.test(uri)) return cb({ returnValue: true, state: state.power });
    if (/getForegroundAppInfo$/.test(uri)) return cb({ returnValue: true, appId: 'com.webos.app.home' });
    if (/getAppInfo$/.test(uri)) return cb({ returnValue: true, appInfo: { id: params.id } });
    if (/turnOnScreenSaver$/.test(uri)) {
      state.requests++;
      var answer = state.answers.shift();
      if (state.onRequest) state.onRequest(answer);
      if (answer === 'invalid') return cb({ returnValue: false, errorText: 'Invalid State change Request' });
      if (answer === 'start') state.power = 'Screen Saver';
      return cb({ returnValue: true });
    }
    if (/\/launch$/.test(uri)) { state.launched++; return cb({ returnValue: true }); }
    if (/\/running$/.test(uri)) return cb({ returnValue: true, running: [] });
    if (/setEplAppInfo$/.test(uri)) return cb({ returnValue: true });
    throw new Error('Unexpected luna call: ' + uri);
  };
  return state;
}

// An idlesaver that records what trigger asks of it.
function fakeIdlesaver(lifts) {
  var fake = { log: [] };
  fake.ownRequest = function () { fake.log.push('own'); };
  fake.lift = function (cb) { fake.log.push('lift'); cb(lifts); };
  fake.restore = function () { fake.log.push('restore'); };
  return fake;
}

function setUp(state, saver) {
  screensavers.init({ luna: state.luna, config: {}, injectKey: function (k, cb) { cb(true); }, KEY_BACK: 412,
    inputKey: require('../server/lib/names').shortAppId,
    mediaState: function (cb) { cb({ state: 'idle', fullScreen: false }); },
    idlesaver: saver });
}

var cases = [];
function test(name, fn) { cases.push([name, fn]); }

test('a plain request tvpower accepts needs no hand-over (C1)', function (done) {
  var state = tv(['start']), saver = fakeIdlesaver(true);
  setUp(state, saver);
  screensavers.trigger(function (r) {
    assert.strictEqual(r.ok, true, r.error);
    assert.deepEqual(saver.log, ['own']);
    assert.strictEqual(state.requests, 1);
    assert.strictEqual(state.launched, 0);
    done();
  });
});

test('a refused plain request is asked again without the hold (G3)', function (done) {
  var state = tv(['refuse', 'start']), saver = fakeIdlesaver(true);
  setUp(state, saver);
  screensavers.trigger(function (r) {
    assert.strictEqual(r.ok, true, r.error);
    assert.deepEqual(saver.log, ['own', 'lift']);
    assert.strictEqual(state.requests, 2);
    assert.strictEqual(state.launched, 0);
    done();
  });
});

test('refused both ways: the hold is put back and the app launched', function (done) {
  var state = tv(['refuse', 'refuse']), saver = fakeIdlesaver(true);
  setUp(state, saver);
  screensavers.trigger(function (r) {
    assert.strictEqual(r.ok, true, r.error);
    assert.deepEqual(saver.log, ['own', 'lift', 'restore']);
    assert.strictEqual(state.requests, 2);
    assert.strictEqual(state.launched, 1);
    done();
  });
});

test('no hand-over possible: no second request, nothing to put back', function (done) {
  var state = tv(['refuse']), saver = fakeIdlesaver(false);
  setUp(state, saver);
  screensavers.trigger(function (r) {
    assert.strictEqual(r.ok, true, r.error);
    assert.deepEqual(saver.log, ['own', 'lift']);
    assert.strictEqual(state.requests, 1);
    assert.strictEqual(state.launched, 1);
    done();
  });
});

test('Invalid State on the plain request still tries without the hold', function (done) {
  var state = tv(['invalid', 'start']), saver = fakeIdlesaver(true);
  setUp(state, saver);
  screensavers.trigger(function (r) {
    assert.strictEqual(r.ok, true, r.error);
    assert.deepEqual(saver.log, ['own', 'lift']);
    assert.strictEqual(state.requests, 2);
    assert.strictEqual(state.launched, 0);
    done();
  });
});

test('Invalid State both ways: the hold is put back and the app launched', function (done) {
  var state = tv(['invalid', 'invalid']), saver = fakeIdlesaver(true);
  setUp(state, saver);
  screensavers.trigger(function (r) {
    assert.strictEqual(r.ok, true, r.error);
    assert.deepEqual(saver.log, ['own', 'lift', 'restore']);
    assert.strictEqual(state.launched, 1);
    done();
  });
});

/*
 * The real idlesaver on a G3-like TV, fed the power states tvpower sends: the
 * plain request is refused within milliseconds, which idlesaver must not take
 * for LG's idle request and lift again on its own.
 */
test('on a G3-like TV the button lifts once and idlesaver does not ask again', function (done) {
  var state = tv(['refuse', 'start']);
  idlesaver.init({ luna: state.luna, mediaState: function (cb) { cb({ state: 'idle', fullScreen: false }); } });
  idlesaver.powerReply({ returnValue: true, state: 'Active' });
  state.onRequest = function (answer) {
    if (answer !== 'refuse') return;
    idlesaver.powerReply({ returnValue: true, state: 'Active', processing: 'Request Screen Saver' });
    idlesaver.powerReply({ returnValue: true, state: 'Active', processing: 'Screen On' });
    idlesaver.powerReply({ returnValue: true, state: 'Active' });
  };
  setUp(state, undefined);
  var logged = [], log = console.log;
  console.log = function (line) { logged.push(String(line)); log.apply(console, arguments); };
  screensavers.trigger(function (r) {
    console.log = log;
    assert.strictEqual(r.ok, true, r.error);
    assert.ok(!logged.some(function (line) { return /refused the idle screen saver/.test(line); }),
      'the button\'s own refused request is not taken for LG\'s idle one');
    var lifts = state.calls.filter(function (c) {
      return /setEplAppInfo$/.test(c.uri) && c.params.supportScreenSaverPolicy === true;
    });
    assert.strictEqual(lifts.length, 1, 'one hand-over, the button\'s');
    assert.strictEqual(state.requests, 2);
    assert.strictEqual(state.launched, 0);
    // The screen saver closes: the hold goes back, and Home was not marked
    // as refusing, so LG's next idle refusal is handed over again.
    idlesaver.powerReply({ returnValue: true, state: 'Screen Saver' });
    state.power = 'Active';
    idlesaver.powerReply({ returnValue: true, state: 'Active' });
    var restores = state.calls.filter(function (c) {
      return /setEplAppInfo$/.test(c.uri) && c.params.supportScreenSaverPolicy === false;
    });
    assert.strictEqual(restores.length, 1);
    setTimeout(function () {
      state.onRequest = null;
      idlesaver.powerReply({ returnValue: true, state: 'Active', processing: 'Request Screen Saver' });
      idlesaver.powerReply({ returnValue: true, state: 'Active', processing: 'Screen On' });
      setTimeout(function () {
        var allLifts = state.calls.filter(function (c) {
          return /setEplAppInfo$/.test(c.uri) && c.params.supportScreenSaverPolicy === true;
        });
        assert.strictEqual(allLifts.length, 2, 'LG\'s idle refusal is still handed over');
        done();
      }, 50);
    }, 5100);
  });
});

(function next(i) {
  if (i >= cases.length) {
    console.log('ALL test-screensaver-trigger.js assertions passed!\n');
    env.restore();
    // idlesaver's own check after a lift is a timer the process need not wait for.
    process.exit(0);
  }
  cases[i][1](function () {
    console.log('  ✓ ' + cases[i][0]);
    next(i + 1);
  });
})(0);
