/*
 * Mimus on the beat (lib/auror-beat, lib/auror-beat-audio and the AUROR
 * saver's beat.js): the tempo and beat found in click tracks made here, the
 * gates on publishing it, the capture's start and stop, and the saver's
 * frame maths. Timers and the clock are fakes. Strict ES5: also runs on
 * node 0.10.
 */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var EventEmitter = require('events').EventEmitter;
var audio = require('../server/lib/auror-beat-audio');
var beatModule = require('../server/lib/auror-beat');
var Beat = require('../server/assets/screensavers/auror/beat.js');
var allocBuffer = require('../server/lib/util').allocBuffer;

console.log('Running test-auror-beat.js ...');

var RATE = audio.RATE;
var seed = 7;
function random() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }

/*
 * A click track at 12 kHz: a short decaying tone every beat over white
 * noise. intervalAt(t) gives the beat's length at t seconds, for one that wanders.
 */
function clicks(bpm, seconds, firstBeat, noise, intervalAt) {
  var out = [], next = firstBeat * RATE, beats = [];
  for (var i = 0; i < seconds * RATE; i++) {
    var v = (random() * 2 - 1) * noise, d = i - next;
    if (d === 0) beats.push(i);
    if (d >= 0 && d < 240) v += 0.6 * Math.exp(-d / 40) * Math.sin(d * 0.7);
    if (d >= 240) next += Math.round((intervalAt ? intervalAt(i / RATE) : 60 / bpm) * RATE);
    out.push(v);
  }
  return { samples: out, beats: beats };
}

function noise(seconds, level) {
  var out = [];
  for (var i = 0; i < seconds * RATE; i++) out.push((random() * 2 - 1) * level);
  return out;
}

function near(a, b, within, what) {
  assert.ok(Math.abs(a - b) <= within, what + ': ' + a + ' is not within ' + within + ' of ' + b);
}

// ---- /proc/asound/pcm
(function () {
  var c1 = [
    '00-06: pcm_output snd-soc-dummy-dai-6 :  : playback 1',
    '00-12: Capture for dsnoop snd-soc-dummy-dai-12 :  : capture 1',
    '01-02: MixerCapture snd-soc-dummy-dai-2 :  : capture 1',
    '01-03: SoundEngineCapture snd-soc-dummy-dai-3 :  : capture 1'
  ].join('\n') + '\n';
  assert.strictEqual(audio.findCaptureDevice(c1), 'hw:0,12');
  assert.strictEqual(audio.findCaptureDevice(c1.replace('00-12: Capture for dsnoop', '00-12: Something else')), null,
    'MixerCapture and SoundEngineCapture are never used');
  assert.strictEqual(audio.findCaptureDevice('00-12: Capture for dsnoop snd-soc-dummy-dai-12 :  : playback 1\n'), null,
    'only a capture');
  assert.strictEqual(audio.findCaptureDevice(''), null);
  console.log('  ✓ the dsnoop capture is found in /proc/asound/pcm, and nothing else stands in for it');
})();

// ---- folding and the lag range
(function () {
  assert.strictEqual(audio.fold(64), 128);
  assert.strictEqual(audio.fold(180), 90);
  assert.strictEqual(audio.fold(120), 120);
  assert.ok(60 * audio.FPS / audio.MIN_LAG >= audio.MAX_BPM && 60 * audio.FPS / audio.MAX_LAG <= audio.MIN_BPM,
    'the lags searched cover 80-160 BPM');
  console.log('  ✓ tempos fold into 80-160 BPM by octaves');
})();

// ---- click tracks
[100, 128, 150, 174].forEach(function (bpm) {
  var track = clicks(bpm, 20, 0.1, 0.05);
  var t = audio.createTracker();
  t.pushSamples(track.samples);
  var e = t.estimate();
  assert.ok(e, bpm + ' BPM: a tempo is published');
  near(e.bpm, audio.fold(bpm), audio.fold(bpm) * 0.01, bpm + ' BPM, after folding');
  assert.ok(e.confidence >= 0.5, bpm + ' BPM: confident');
  // On any click: at 174 BPM the beat folded to 87 may fall on either of two.
  var period = 60 / bpm * RATE;
  var last = track.beats[track.beats.length - 1];
  var d = ((e.beatSample - last) % period + period) % period;
  if (d > period / 2) d -= period;
  near(d / RATE * 1000, 0, 30, bpm + ' BPM: the beat in ms');
});
console.log('  ✓ 100, 128, 150 and 174 BPM click tracks: tempo within 1% after folding, beat within 30 ms');

(function () {
  var t = audio.createTracker();
  t.pushSamples(noise(25, 0.3));
  assert.strictEqual(t.estimate(), null, 'white noise');
  t = audio.createTracker();
  t.pushSamples(noise(25, 0));
  assert.strictEqual(t.estimate(), null, 'silence');
  assert.ok(t.silent());
  // From 108 to 132 BPM and back, every 12 s: no steady tempo.
  t = audio.createTracker();
  t.pushSamples(clicks(120, 30, 0.1, 0.05, function (s) { return 0.5 / (1 + 0.1 * Math.sin(s * Math.PI / 6)); }).samples);
  assert.strictEqual(t.estimate(), null, 'a tempo wandering by 10%');
  console.log('  ✓ white noise, silence and a wandering tempo publish nothing');
})();

(function () {
  var t = audio.createTracker();
  t.pushSamples(clicks(120, 10, 0.1, 0.05).samples);
  assert.strictEqual(t.estimate(), null, 'not before six windows agree');
  t.pushSamples(clicks(120, 10, 0.1, 0.05).samples);
  assert.ok(t.estimate(), 'after 18 s');
  t.pushSamples(noise(0.5, 0));
  assert.strictEqual(t.estimate(), null, 'paused: null at once');
  t.pushSamples(clicks(120, 10, 0.1, 0.05).samples);
  assert.strictEqual(t.estimate(), null, 'the windows from before the pause are gone');
  console.log('  ✓ published only once six windows agree; a pause clears them');
})();

// ---- stability and hysteresis
(function () {
  assert.strictEqual(audio.stability([120, 120, 120, 120, 120]), null, 'five windows are not enough');
  var s = audio.stability([120, 120.5, 119.8, 120.2, 120, 120.1]);
  near(s.bpm, 120.05, 0.001, 'the median');
  assert.ok(s.confidence > 0.8);
  assert.ok(audio.stability([100, 120, 120, 120, 120, 120]).confidence === 0, 'a spread of 17%');
  near(audio.stability([117, 117, 117, 120, 120, 120]).confidence, 1 - (120 / 117 - 1) / 0.05, 1e-9, '1 - spread / 5%');
  // Near the ends of the octave a window may fold either way: still one tempo.
  var edge = audio.stability([159.5, 80.2, 159.8, 80.1, 159.9, 80.3]);
  assert.ok(edge.confidence >= 0.5, 'jitter across 80/160 still publishes');
  near(audio.octaveDistance(edge.bpm, 160), 0, 0.005, 'as about 80 or 160');
  near(audio.octaveDistance(159, 80.5), 80.5 / 79.5 - 1, 1e-9, 'an octave apart counts as the same');

  var t = audio.createTracker();
  t.pushSamples(clicks(120, 20, 0.1, 0.02).samples);
  var first = t.estimate().bpm;
  t.pushSamples(clicks(121.2, 14, 0.1, 0.02).samples);
  assert.strictEqual(t.estimate().bpm, first, 'a 1% change is not republished');
  t.pushSamples(clicks(126, 20, 0.1, 0.02).samples);
  near(t.estimate().bpm, 126, 1.3, 'a 5% change is');
  assert.strictEqual(audio.nearestOctave(82, 159), 164, 'from 159, a new 82 is taken as 164, not halved');
  assert.strictEqual(audio.nearestOctave(155, 82), 77.5, 'from 82, a new 155 is taken as 77.5, not doubled');
  assert.strictEqual(audio.nearestOctave(126, 120), 126);
  assert.strictEqual(audio.nearestOctave(150, 30), 75, 'never past 64-200');
  // Published near 160, then a 3% faster song whose windows fold to about 82.
  t = audio.createTracker();
  t.pushSamples(clicks(158, 20, 0.1, 0.02).samples);
  near(t.estimate().bpm, 158, 1.6, 'near 160 first');
  t.pushSamples(clicks(164, 24, 0.1, 0.02).samples);
  near(t.estimate().bpm, 164, 1.7, 'republished at 164, not 82');
  console.log('  ✓ six windows within 2.5% publish their median; a 1% wobble keeps the tempo, 5% moves it');
  console.log('  ✓ a republished tempo stays in the octave it was in');
})();

// Click tracks at the ends of the octave, with their beats a little early or late.
[80.3, 159.6].forEach(function (bpm) {
  var t = audio.createTracker();
  t.pushSamples(clicks(bpm, 24, 0.1, 0.05, function () { return 60 / bpm + (random() - 0.5) * 0.008; }).samples);
  var e = t.estimate();
  assert.ok(e, bpm + ' BPM with jitter: published');
  assert.ok(audio.octaveDistance(e.bpm, bpm) < 0.01, bpm + ' BPM with jitter: ' + e.bpm);
});
console.log('  ✓ jittered click tracks near 80 and 160 BPM still publish');

// ---- the 48 kHz stereo capture, decimated
(function () {
  var frames = 48000 * 3, raw = allocBuffer(frames * 4), want = [];
  var sum = 0;
  for (var i = 0; i < frames; i++) {
    var l = Math.round(Math.sin(i / 7) * 12000 + (random() - 0.5) * 2000), r = Math.round(Math.cos(i / 11) * -9000);
    raw.writeInt16LE(l, i * 4);
    raw.writeInt16LE(r, i * 4 + 2);
    sum += l + r;
    if (i % 4 === 3) { want.push(sum / (8 * 32768)); sum = 0; }
  }
  // Each hop's onset and window energy, and the samples counted.
  function hops(feed) {
    var out = [];
    var t = audio.createTracker({ hop: function (onset, energy) { out.push(onset, energy); }, analysed: function () {} });
    feed(t);
    return { hops: out, samples: t.samples() };
  }
  var fromSamples = hops(function (t) { t.pushSamples(want); });
  var whole = hops(function (t) { t.push(raw); });
  var split = hops(function (t) {
    for (var at = 0, k = 0, sizes = [1, 3, 5, 7, 2, 11, 13]; at < raw.length; k++) {
      var n = sizes[k % sizes.length];
      t.push(raw.slice(at, at + n));
      at += n;
    }
  });
  assert.strictEqual(whole.samples, want.length, '4 frames of 48 kHz stereo make one sample at 12 kHz');
  assert.ok(fromSamples.hops.length >= 2 * 280, 'every hop seen');
  assert.deepEqual(whole, fromSamples, 'the raw capture gives the hops its 12 kHz samples give');
  assert.deepEqual(split, whole, 'split at odd bytes, the same hops');
  console.log('  ✓ 48 kHz stereo is averaged down to 12 kHz mono, whatever bytes the chunks split at');
})();

// Click tracks at 48 kHz stereo through push(), as arecord gives them, split at odd offsets.
(function () {
  var mono = clicks(128, 20, 0.1, 0.05);
  var raw = allocBuffer(mono.samples.length * 16);
  for (var i = 0; i < mono.samples.length; i++) {
    for (var j = 0; j < 4; j++) {
      var v = Math.max(-32768, Math.min(32767, Math.round(mono.samples[i] * 32767)));
      raw.writeInt16LE(v, (i * 4 + j) * 4);
      raw.writeInt16LE(v, (i * 4 + j) * 4 + 2);
    }
  }
  var t = audio.createTracker();
  for (var at = 0, k = 0; at < raw.length; k++) {
    var n = 4093 + (k % 5) * 2;
    t.push(raw.slice(at, at + n));
    at += n;
  }
  near(t.estimate().bpm, 128, 1.28, 'from the raw capture');
  console.log('  ✓ the same tempo through the raw 48 kHz capture');
})();

// ---- lifecycle
var dir = path.join(os.tmpdir(), 'auror-beat-' + process.pid);
fs.mkdirSync(dir);
var pidFile = path.join(dir, 'capture.pid');
var PCM = '00-12: Capture for dsnoop snd-soc-dummy-dai-12 :  : capture 1\n';
var CMD = 'arecord\u0000-q\u0000-D\u0000hw:0,12\u0000-c\u00002\u0000-f\u0000S16_LE\u0000-r\u000048000\u0000-t\u0000raw\u0000';

var now = 1000000;
var timers = [], intervals = [];
global.setTimeout = function (fn, ms) { var t = { fn: fn, at: now + ms }; timers.push(t); return t; };
global.clearTimeout = function (t) { var i = timers.indexOf(t); if (i !== -1) timers.splice(i, 1); };
// The FIFO's read loop: run by drain(), not by the clock.
global.setInterval = function (fn, ms) { var t = { fn: fn, ms: ms, unref: function () {} }; intervals.push(t); return t; };
global.clearInterval = function (t) { var i = intervals.indexOf(t); if (i !== -1) intervals.splice(i, 1); };
function advance(ms) {
  now += ms;
  timers.filter(function (t) { return t.at <= now; }).forEach(function (t) { global.clearTimeout(t); t.fn(); });
}

var env, queued, spawned, killed, files, musicReads, exitHook, spawnFails;

/*
 * The FIFO, faked: made by a fake mkfifo, read from a queue of chunks the
 * test writes. readSync throws EAGAIN once the queue is empty, and gives 0
 * once the writer has closed.
 */
var fifoPath = path.join(dir, 'capture.fifo');
var fifo, makers, openFds, nextFd, reads;
function fsError(code) { var e = new Error(code); /** @type {any} */ (e).code = code; return e; }
var fakeFs = {
  openSync: function (p, flags) {
    // The write end is opened through the read end's fd, which must be open.
    var viaFd = /\/self\/fd\/(\d+)$/.exec(p);
    if (viaFd) assert.ok(viaFd[1] in openFds, 'the write end opened through an open read fd');
    else assert.strictEqual(p, fifoPath);
    if (!fifo.exists) throw fsError('ENOENT');
    var fd = nextFd++;
    openFds[fd] = flags;
    return fd;
  },
  fstatSync: function (fd) {
    assert.ok(fd in openFds, 'fstat of an open fd');
    return { isFIFO: function () { return !fifo.notFifo; }, uid: process.getuid(), ino: 77, dev: 3 };
  },
  readSync: function (fd, buf, off, len) {
    assert.ok(fd in openFds, 'read of an open fd');
    reads++;
    if (!fifo.chunks.length) {
      if (fifo.writerClosed) return 0;
      throw fsError('EAGAIN');
    }
    var chunk = fifo.chunks[0], n = Math.min(len, chunk.length);
    chunk.copy(buf, off, 0, n);
    if (n === chunk.length) fifo.chunks.shift();
    else fifo.chunks[0] = chunk.slice(n);
    return n;
  },
  closeSync: function (fd) {
    assert.ok(fd in openFds, 'close of an open fd');
    delete openFds[fd];
  },
  unlinkSync: function (p) {
    if (p !== fifoPath) return fs.unlinkSync(p);
    if (!fifo.exists) throw fsError('ENOENT');
    fifo.exists = false;
  },
  writeFileSync: function (p, data, o) { return fs.writeFileSync(p, data, o); }
};
function mkfifoChild() {
  var c = new EventEmitter();
  makers.push(c);
  return c;
}
// Writes to the FIFO, then runs its read loop.
function feed(buf) {
  fifo.chunks.push(buf);
  drain();
}
function drain() { intervals.slice().forEach(function (t) { assert.strictEqual(t.ms, 50); t.fn(); }); }
function noLeaks(what) {
  assert.deepEqual(Object.keys(openFds), [], what + ': no fd left open');
  assert.strictEqual(intervals.length, 0, what + ': no read loop left');
  assert.ok(!fifo.exists, what + ': the FIFO removed');
}
function fakeChild() {
  var c = new EventEmitter();
  c.pid = 4000 + spawned.length;
  c.killedWith = null;
  c.kill = function (sig) { c.killedWith = sig; };
  return c;
}
function setup(over) {
  env = { since: now, mode: 'auror', app: 'spotify-beehive', playing: true, look: { mascots: true, followBeat: true }, webos: '6.5.3', pcm: PCM };
  for (var k in over || {}) env[k] = over[k];
  queued = [];
  spawned = [];
  killed = [];
  files = {};
  timers = [];
  musicReads = 0;
  exitHook = null;
  spawnFails = null;
  fifo = { exists: false, notFifo: false, chunks: [], writerClosed: false, mkfifoFails: false };
  makers = [];
  openFds = {};
  nextFd = 20;
  reads = 0;
  intervals = [];
  beatModule.init({
    home: /** @type {any} */ ({
      screenSaverSince: function () { return env.since; },
      layout: function () { return { look: env.look }; },
      musicApp: function () { return env.app; },
      musicPlaying: function (cb) { musicReads++; cb(env.playing); }
    }),
    screensavers: /** @type {any} */ ({ screensaverMode: function () { return env.mode; } }),
    webosVersion: env.webos,
    launch: function (fn) { queued.push(fn); },
    spawn: function (file, args, o) {
      if (spawnFails) throw spawnFails;
      if (file === 'mkfifo') {
        assert.deepEqual(args, ['-m', '600', fifoPath]);
        return mkfifoChild();
      }
      assert.ok(o.stdio[1] in openFds && openFds[o.stdio[1]] === require('constants').O_WRONLY | require('constants').O_NOFOLLOW,
        'arecord writes to the FIFO\'s write end');
      var c = fakeChild();
      c.cmd = [file].concat(args);
      spawned.push(c);
      return c;
    },
    now: function () { return now; },
    readFile: function (f) {
      if (f === '/proc/asound/pcm') { if (env.pcm === null) throw new Error('ENOENT'); return env.pcm; }
      if (f in files) return files[f];
      return fs.readFileSync(f, 'utf8');
    },
    kill: function (pid, sig) { killed.push([pid, sig]); },
    pidFile: pidFile,
    fifo: fifoPath,
    fs: fakeFs,
    procDir: '/fakeproc',
    outputLatencyMs: env.latency,
    onExit: function (fn) { exitHook = fn; },
    noTick: true,
    noKick: !env.kick
  });
}
// Runs the starts waiting their turn, and the mkfifo they start, until none is left.
function runQueued() {
  while (queued.length || makers.length) {
    var q = queued;
    queued = [];
    q.forEach(function (fn) { fn(); });
    var m = makers;
    makers = [];
    m.forEach(function (c) {
      if (fifo.mkfifoFails || fifo.exists) return c.emit('exit', 1, null);
      fifo.exists = true;
      c.emit('exit', 0, null);
    });
  }
}
function exit(c) { c.exited = true; c.emit('exit', 1, null); }
function pollAndTick() { beatModule.polled(); beatModule.tick(); runQueued(); }

(function () {
  setup();
  pollAndTick();
  assert.strictEqual(spawned.length, 1, 'all gates hold: the capture starts');
  assert.deepEqual(spawned[0].cmd, ['arecord', '-q', '-D', 'hw:0,12', '-c', '2', '-f', 'S16_LE', '-r', '48000', '-t', 'raw']);
  assert.strictEqual(fs.readFileSync(pidFile, 'utf8'), String(spawned[0].pid), 'its pid is kept');
  assert.ok(fifo.exists, 'the FIFO made');
  assert.strictEqual(Object.keys(openFds).length, 1, 'only the read end stays open in node');
  assert.strictEqual(intervals.length, 1, 'and read every 50 ms');
  env.since = 0;
  advance(5000);
  beatModule.tick();
  assert.strictEqual(spawned[0].killedWith, 'SIGTERM', 'saver gone: stopped by the next tick');
  assert.ok(!fs.existsSync(pidFile), 'and its pidfile removed');
  noLeaks('stopped');

  setup();
  pollAndTick();
  advance(15001);
  beatModule.tick();
  assert.strictEqual(spawned[0].killedWith, 'SIGTERM', 'no poll for 15 s: stopped');
  console.log('  ✓ the capture stops within a tick of the saver going, or of 15 s without a poll');
})();

(function () {
  [
    [{ mode: 'auror-immich' }, 'AUROR · Immich polls too, with no Mimus'],
    [{ look: { mascots: false, followBeat: true } }, 'mascots off'],
    [{ look: { mascots: true, followBeat: false } }, 'following the beat off'],
    [{ webos: '9.2.0' }, 'webOS 9, not on the allowlist'],
    [{ pcm: '01-02: MixerCapture snd-soc-dummy-dai-2 :  : capture 1\n' }, 'no dsnoop capture'],
    [{ pcm: null }, 'no /proc/asound/pcm'],
    [{ app: null }, 'no music app'],
    [{ playing: false }, 'paused'],
    [{ since: 0 }, 'no screen saver']
  ].forEach(function (c) {
    setup(c[0]);
    pollAndTick();
    assert.strictEqual(spawned.length, 0, c[1] + ': no capture');
  });
  setup();
  beatModule.tick();
  runQueued();
  assert.strictEqual(spawned.length, 0, 'never polled: no capture');
  console.log('  ✓ no capture for AUROR · Immich, mascots or the beat off, webOS 9, no device, no music, no poll');
})();

(function () {
  setup();
  beatModule.polled();
  beatModule.tick();
  assert.strictEqual(queued.length, 1);
  env.since = 0;
  beatModule.tick();
  runQueued();
  assert.strictEqual(spawned.length, 0, 'stopped while queued: nothing spawned');
  console.log('  ✓ a stop while the start waits its turn spawns nothing');
})();

(function () {
  setup();
  pollAndTick();
  var waits = [1000, 2000, 4000];
  for (var i = 0; i < 3; i++) {
    exit(spawned[spawned.length - 1]);
    noLeaks('ended, waiting to start again');
    beatModule.polled();
    advance(waits[i] - 1);
    runQueued();
    assert.strictEqual(spawned.length, i + 1, 'not before ' + waits[i] + ' ms');
    advance(1);
    runQueued();
    assert.strictEqual(spawned.length, i + 2, 'again after ' + waits[i] + ' ms');
    assert.ok(fifo.exists && intervals.length === 1, 'started again through a new FIFO');
  }
  exit(spawned[spawned.length - 1]);
  advance(10000);
  pollAndTick();
  assert.strictEqual(spawned.length, 4, 'the third retry ending as fast: given up');
  noLeaks('given up');

  // Two fast exits, then one after 11 s: the wait is 1 s again, not 4.
  function retryWait() {
    exit(spawned[spawned.length - 1]);
    var before = spawned.length;
    for (var ms = 0; ms < 5000; ms += 500) {
      beatModule.polled();
      advance(500);
      runQueued();
      if (spawned.length > before) return ms + 500;
    }
    return null;
  }
  setup();
  pollAndTick();
  assert.strictEqual(retryWait(), 1000);
  assert.strictEqual(retryWait(), 2000);
  for (var t = 0; t < 11; t++) { beatModule.polled(); advance(1000); }
  assert.strictEqual(retryWait(), 1000, 'an exit after 10 s is not a fast one');

  // Two fast exits, then a long run ended by a stop: the count starts again.
  setup();
  pollAndTick();
  retryWait();
  retryWait();
  for (t = 0; t < 11; t++) { beatModule.polled(); advance(1000); }
  beatModule.stop();
  pollAndTick();
  assert.strictEqual(spawned.length, 4);
  assert.strictEqual(retryWait(), 1000, 'a long run ended by a stop resets the count');
  assert.strictEqual(retryWait(), 2000, 'and nothing is given up');

  // Ended by a stop: its exit is expected, and starts nothing.
  setup();
  pollAndTick();
  beatModule.stop();
  noLeaks('stopped');
  exit(spawned[0]);
  assert.strictEqual(timers.length, 0, 'no retry after a stop');
  advance(5000);
  runQueued();
  assert.strictEqual(spawned.length, 1);

  // arecord missing: spawn throws, or the child reports an error with no pid.
  setup();
  spawnFails = new Error('spawn arecord ENOENT');
  pollAndTick();
  assert.strictEqual(spawned.length, 0);
  assert.strictEqual(timers.length, 1, 'a spawn that throws is retried');
  spawnFails = null;
  beatModule.polled();
  advance(1000);
  runQueued();
  assert.strictEqual(spawned.length, 1);
  try { fs.unlinkSync(pidFile); } catch (e) {}
  setup();
  var noPid = fakeChild();
  noPid.pid = undefined;
  beatModule.init({
    home: /** @type {any} */ ({ screenSaverSince: function () { return 1; }, layout: function () { return { look: { mascots: true } }; },
      musicApp: function () { return 'spotify'; }, musicPlaying: function (cb) { cb(true); } }),
    screensavers: /** @type {any} */ ({ screensaverMode: function () { return 'auror'; } }),
    webosVersion: '6.5.3', launch: function (fn) { queued.push(fn); },
    spawn: function (file) { if (file === 'mkfifo') return mkfifoChild(); spawned.push(noPid); return noPid; },
    now: function () { return now; }, readFile: function () { return PCM; }, pidFile: pidFile, fifo: fifoPath, fs: fakeFs,
    onExit: function () {}, noTick: true
  });
  pollAndTick();
  assert.ok(!fs.existsSync(pidFile), 'no pid, no pidfile');
  noPid.emit('error', new Error('spawn arecord ENOENT'));
  noPid.emit('exit', -2, null);
  assert.strictEqual(timers.length, 1, 'error then exit: one retry');
  noLeaks('error then exit');

  // The server exiting kills the capture.
  setup();
  pollAndTick();
  exitHook();
  assert.strictEqual(spawned[0].killedWith, 'SIGTERM', 'killed on exit');
  noLeaks('server exiting');
  console.log('  ✓ a capture that ends starts again after 1, 2 and 4 s, and is given up when the third retry ends as fast');
  console.log('  ✓ a long run resets the count, a stop\'s exit starts nothing, a failed spawn is retried, exit kills it');
})();

(function () {
  setup();
  pollAndTick();
  var c = spawned[0];
  var zeros = allocBuffer(48000 * 4);
  for (var s = 0; s <= 30; s++) { feed(zeros); beatModule.polled(); advance(1000); }
  assert.strictEqual(c.killedWith, 'SIGTERM', '30 s of silence: stopped');
  noLeaks('resting');
  advance(5000);
  pollAndTick();
  assert.strictEqual(spawned.length, 1, 'not again within a minute');
  for (var w = 0; w < 11; w++) { advance(5000); pollAndTick(); }
  assert.strictEqual(spawned.length, 2, 'started again after a minute, music still playing');
  c = spawned[1];
  for (s = 0; s <= 30; s++) { feed(zeros); beatModule.polled(); advance(1000); }
  assert.strictEqual(c.killedWith, 'SIGTERM', 'silent again: stopped');
  for (w = 0; w < 13; w++) { advance(5000); pollAndTick(); }
  assert.strictEqual(spawned.length, 2, 'the second rest is two minutes');
  for (w = 0; w < 12; w++) { advance(5000); pollAndTick(); }
  assert.strictEqual(spawned.length, 3, 'started again after two');
  console.log('  ✓ 30 s of silence stops the capture for a minute, then two, and it starts again');
})();

(function () {
  setup();
  pollAndTick();
  for (var s = 0; s < 5; s++) { advance(5000); pollAndTick(); }
  assert.strictEqual(spawned[0].killedWith, null, 'not before 30 s');
  advance(5000);
  pollAndTick();
  assert.strictEqual(spawned[0].killedWith, 'SIGTERM', 'a capture giving nothing for 30 s is stopped');
  assert.strictEqual(spawned.length, 1, 'and rests');
  console.log('  ✓ a capture that has stalled is stopped as for silence');
})();

(function () {
  setup();
  beatModule.polled(true);
  beatModule.tick();
  assert.strictEqual(musicReads, 0, 'the music the saver\'s poll just read is used');
  advance(5000);
  beatModule.tick();
  assert.strictEqual(musicReads, 1, 'past 5 s it is read again');
  console.log('  ✓ the music state read for the poll is used for 5 s');
})();

(function () {
  setup();
  fs.writeFileSync(pidFile, '321');
  files['/fakeproc/321/cmdline'] = 'arecord\u0000-D\u0000hw:0,12\u0000';
  pollAndTick();
  assert.deepEqual(killed, [], 'a pid whose command line is not exactly the capture is left alone');
  beatModule.stop();
  fs.writeFileSync(pidFile, '322');
  files['/fakeproc/322/cmdline'] = CMD;
  advance(5000);
  pollAndTick();
  assert.deepEqual(killed, [[322, 'SIGTERM']], 'the exact capture left from before is stopped');
  console.log('  ✓ a leftover capture is killed only when its command line matches exactly');
})();

(function () {
  setup({ kick: true });
  beatModule.polled();
  runQueued();
  assert.strictEqual(spawned.length, 1, 'a poll starts the capture without waiting for the tick');
  var reads0 = musicReads;
  beatModule.polled();
  runQueued();
  assert.strictEqual(musicReads, reads0, 'a capture running: a poll asks nothing more');
  assert.strictEqual(spawned.length, 1);
  exit(spawned[0]);
  beatModule.polled();
  runQueued();
  assert.strictEqual(spawned.length, 1, 'a respawn pending: a poll leaves it to its timer');

  setup();
  beatModule.polled();
  runQueued();
  assert.strictEqual(spawned.length, 0, 'with noKick, only tick() starts it');
  console.log('  ✓ a poll starts the capture at once when none is running or waiting, unless noKick');
})();

// ---- the published beat
(function () {
  var realTracker = audio.createTracker, est = null, logs = [], realLog = console.log;
  audio.createTracker = function () {
    var t = realTracker();
    t.estimate = function () { return est; };
    return t;
  };
  setup();
  pollAndTick();
  feed(allocBuffer(4000));
  est = { bpm: 120, beatSample: 0, confidence: 0.7 };
  console.log = function (line) { logs.push(line); };
  var b1 = beatModule.beat();
  est = { bpm: 120, beatSample: 0, confidence: 0.9 };
  beatModule.beat();
  est = { bpm: 126, beatSample: 0, confidence: 0.9 };
  beatModule.beat();
  console.log = realLog;
  audio.createTracker = realTracker;
  beatModule.stop();
  assert.deepEqual(Object.keys(b1).sort(), ['bpm', 'confidence', 'epoch', 'phase', 'source']);
  assert.deepEqual(logs, ['auror-beat: beat 120 BPM (audio, tempo only)',
    'auror-beat: beat 126 BPM (audio, tempo only)'], 'logged once per tempo');
  console.log('  ✓ the beat as published, logged once per tempo');
})();

function rawClicks(bpm, seconds) {
  var track = clicks(bpm, seconds, 0.1, 0.05).samples;
  var raw = allocBuffer(track.length * 16);
  for (var i = 0; i < track.length; i++) {
    var v = Math.round(track[i] * 32767);
    for (var j = 0; j < 4; j++) { raw.writeInt16LE(v, (i * 4 + j) * 4); raw.writeInt16LE(v, (i * 4 + j) * 4 + 2); }
  }
  return raw;
}

(function () {
  var raw = rawClicks(120, 80), second = 48000 * 4;
  [undefined, 25].forEach(function (latency) {
    setup({ latency: latency });
    pollAndTick();
    assert.strictEqual(beatModule.beat(), null, 'nothing heard yet');
    feed(raw.slice(0, 20 * second));
    var b = beatModule.beat();
    assert.ok(b, 'a beat after 20 s of clicks');
    assert.strictEqual(b.source, 'audio');
    assert.strictEqual(b.phase, latency !== undefined, latency === undefined ? 'uncalibrated: tempo only' : 'calibrated: on the beat');
    near(b.bpm, 120, 1.2, 'bpm');
    assert.ok(b.confidence >= 0.5);
    var period = 60000 / b.bpm, offset = latency || 0;
    // The capture goes on arriving in 0.7 s chunks.
    for (var at = 20 * second; at + 0.7 * second <= raw.length; at += 0.7 * second) {
      advance(700);
      feed(raw.slice(at, at + 0.7 * second));
      var now_ = beatModule.beat();
      assert.ok(now_.epoch - offset <= now && now - (now_.epoch - offset) < period + 1, 'epoch is the latest beat, never more than a period old');
    }
    advance(1001);
    assert.strictEqual(beatModule.beat(), null, 'nothing new for a second: no beat');
  });
  console.log('  ✓ the beat: tempo only until the latency is calibrated, epoch the latest beat, null once the sound stops');
})();

// ---- the FIFO
(function () {
  // A path left from before is removed first: the fake mkfifo fails on an existing one.
  setup();
  fifo.exists = true;
  pollAndTick();
  assert.strictEqual(spawned.length, 1, 'a leftover at the path is replaced');

  setup();
  fifo.mkfifoFails = true;
  pollAndTick();
  assert.strictEqual(spawned.length, 0, 'mkfifo failing: no arecord');
  assert.strictEqual(timers.length, 1, 'and retried as a failed start');
  noLeaks('mkfifo failing');

  setup();
  fifo.notFifo = true;
  pollAndTick();
  assert.strictEqual(spawned.length, 0, 'not a FIFO at the path: refused without spawning');
  assert.strictEqual(timers.length, 1, 'and retried as a failed start');
  noLeaks('not a FIFO');

  // Stopped while mkfifo runs: what it made is removed, and nothing is spawned.
  setup();
  beatModule.polled();
  beatModule.tick();
  var q = queued;
  queued = [];
  q.forEach(function (fn) { fn(); });
  assert.strictEqual(makers.length, 1);
  beatModule.stop();
  runQueued();
  assert.strictEqual(spawned.length, 0, 'stopped while mkfifo ran: nothing spawned');
  noLeaks('stopped while mkfifo ran');
  console.log('  ✓ the FIFO is made fresh, refused when it is not one, and removed on stop, respawn and give-up');
})();

(function () {
  setup();
  pollAndTick();
  var big = allocBuffer(65536 * 3);
  feed(big);
  assert.strictEqual(reads, 4, 'three full reads, then EAGAIN ends the loop');
  drain();
  assert.strictEqual(reads, 5, 'an empty FIFO: one read');
  feed(allocBuffer(1000));
  assert.strictEqual(reads, 6, 'a short read ends the loop without another');
  fifo.writerClosed = true;
  drain();
  assert.strictEqual(reads, 7);
  assert.deepEqual(Object.keys(openFds), [], 'arecord closed its end: the read end closed');
  assert.strictEqual(intervals.length, 0, 'and the loop stopped');
  assert.ok(fifo.exists, 'the FIFO stays until arecord exits');
  exit(spawned[0]);
  noLeaks('arecord exited');
  console.log('  ✓ each 50 ms the FIFO is read until empty or short; a closed writer stops reading');
})();

(function () {
  var raw = rawClicks(120, 25), chunk = 19200;
  // Each 100 ms chunk read at its end plus delayOf(k) ms, and the beat asked for 10 ms after the last.
  function epochWith(delayOf) {
    setup();
    pollAndTick();
    var start = now, k = 0;
    for (var at = 0; at + chunk <= raw.length; at += chunk, k++) {
      now = start + (k + 1) * 100 + delayOf(k);
      feed(raw.slice(at, at + chunk));
    }
    now = start + k * 100 + 10;
    var b = beatModule.beat();
    // Each run's clock starts where the last left it.
    if (b) b.epoch -= start;
    return b;
  }
  var exact = epochWith(function () { return 0; });
  var mixed = epochWith(function (k) { return k % 2 ? 10 : 0; });
  var late = epochWith(function () { return 10; });
  assert.ok(exact && mixed && late, 'a beat');
  assert.strictEqual(mixed.bpm, exact.bpm);
  near(mixed.epoch, exact.epoch, 1, 'reads 0 or 10 ms late, the last one late: the epoch of reads on time');
  near(late.epoch, exact.epoch + 10, 1, 'every read 10 ms late: the epoch is 10 ms late too');
  console.log('  ✓ the epoch comes from the least delayed read of the last 2 s');
})();

// The tracker's decisions are the same whether the capture comes 100 ms or 2048 bytes at a time.
(function () {
  var mono = clicks(120, 20, 0.1, 0.05).samples.concat(noise(0.5, 0), clicks(128, 20, 0.1, 0.05).samples, noise(10, 0.3));
  var raw = allocBuffer(mono.length * 16);
  for (var i = 0; i < mono.length; i++) {
    var v = Math.max(-32768, Math.min(32767, Math.round(mono[i] * 32767)));
    for (var j = 0; j < 4; j++) { raw.writeInt16LE(v, (i * 4 + j) * 4); raw.writeInt16LE(v, (i * 4 + j) * 4 + 2); }
  }
  // What was published after each 100 ms of capture, and every analysis's decision.
  function run(size) {
    var decisions = [], seen = [];
    var t = audio.createTracker({ hop: function () {}, analysed: function (at, bpm, published) {
      decisions.push([at, bpm, published && published.bpm, published && published.confidence]);
    } });
    for (var at = 0; at < raw.length;) {
      var boundary = (Math.floor(at / 19200) + 1) * 19200, end = Math.min(at + size, boundary, raw.length);
      t.push(raw.slice(at, end));
      at = end;
      if (at % 19200 === 0) {
        var e = t.estimate();
        seen.push(e ? e.bpm + '@' + e.beatSample : null);
      }
    }
    return { decisions: decisions, seen: seen };
  }
  var reads = run(19200), stream = run(2048);
  assert.deepEqual(reads, stream, 'the same decisions and tempo');
  var tempos = reads.seen.filter(function (x, k) { return x && x !== reads.seen[k - 1]; }).map(function (x) { return Math.round(parseFloat(x)); });
  assert.ok(tempos.indexOf(120) !== -1 && tempos.indexOf(128) !== -1, '120 then 128 published: ' + tempos);
  assert.ok(reads.seen.indexOf(null, 210) !== -1, 'and none through the pause');
  console.log('  ✓ 100 ms reads publish what 2048-byte reads do, at the same samples');
})();

// ---- the saver's frame maths (beat.js)
(function () {
  var n = 4;
  var st = Beat.follow(null, { bpm: 120, epoch: 10000, phase: true, confidence: 1 }, 9000);
  assert.strictEqual(st.anchor, 10000, 'phase: starts on the server\'s beat');
  for (var t = 8000; t < 12000; t += 37) {
    var f = Beat.frameAt(st, t, n);
    assert.ok(f >= 0 && f < n && f === Math.floor(f), 'a future epoch still gives a frame 0..3');
  }
  assert.strictEqual(Beat.frameAt(st, 10000, n), 0, 'frame 0 on the beat');
  assert.strictEqual(Beat.frameAt(st, 10250, n), 1);
  assert.strictEqual(Beat.frameAt(st, 10500, n), 2, 'frame 2 on the next beat');
  assert.strictEqual(Beat.frameAt(st, 9750, n), 3, 'and 3 just before an anchor ahead of now');
  assert.strictEqual(Beat.untilNext(st, 10100), 150);

  var same = Beat.follow(st, { bpm: 120, epoch: 20020, phase: true, confidence: 1 }, 20000);
  assert.strictEqual(same.easeMs, 0, '20 ms off: left alone');
  assert.strictEqual(Beat.anchorAt(same, 20000), 10000);
  var eased = Beat.follow(st, { bpm: 120, epoch: 20060, phase: true, confidence: 1 }, 20000);
  assert.strictEqual(eased.easeMs, 2000, '60 ms off: eased over four beats');
  assert.strictEqual(Beat.anchorAt(eased, 20000), 10000, 'from where it was');
  near(Beat.anchorAt(eased, 21000), 10030, 1e-9, 'halfway at two beats');
  near(Beat.anchorAt(eased, 22500), 10060, 1e-9, 'there after four');
  assert.strictEqual(Beat.offBy(10000, 20560, 120), 60, 'the nearest beat either way');
  assert.strictEqual(Beat.offBy(10000, 20440, 120), -60);
  assert.strictEqual(Beat.follow(eased, { bpm: 120, epoch: 30070, phase: true, confidence: 1 }, 20500), eased,
    'a beat near where it is easing to lets the ease carry on');

  var guess = Beat.follow(st, { bpm: 120, epoch: 20200, phase: false, confidence: 1 }, 20000);
  assert.strictEqual(guess.anchor, 10000, 'tempo only: the anchor is kept');
  var faster = Beat.follow(st, { bpm: 130, epoch: 0, phase: false, confidence: 1 }, 20100);
  assert.strictEqual(Beat.frameAt(faster, 20100, n), Beat.frameAt(st, 20100, n), 'a new tempo does not make him jump');
  near((20100 - faster.anchor) / (30000 / 130), (20100 - 10000) / 250, 1e-9, 'it carries on from the same place');
  var retimed = Beat.follow(st, { bpm: 125, epoch: 20000, phase: true, confidence: 1 }, 20100);
  assert.strictEqual(Beat.anchorAt(retimed, 20100), Beat.anchorAt(Beat.follow(st, { bpm: 125, epoch: 0, phase: false, confidence: 1 }, 20100), 20100),
    'with phase, a new tempo re-anchors at the change before easing');

  assert.strictEqual(Beat.usable(null, 0), null);
  assert.ok(Beat.usable({ bpm: 120, epoch: 1000, confidence: 0.9 }, 5000));
  assert.strictEqual(Beat.usable({ bpm: 120, epoch: 1000, confidence: 0.4 }, 5000), null, 'unsure');
  assert.strictEqual(Beat.usable({ bpm: 220, epoch: 1000, confidence: 1 }, 5000), null, 'out of range');
  assert.strictEqual(Beat.usable({ bpm: 120, epoch: 1000, confidence: 1 }, 12000), null, 'more than 10 s old');
  console.log('  ✓ the saver: frames for a future epoch, 40 ms let be, 4-beat easing, tempo only keeps the anchor');
})();

// The saver asks for the beat every second: the same beat again changes nothing.
(function () {
  var n = 4, t0 = 50000;
  [true, false].forEach(function (phase) {
    var beatAt = function (at) {
      // As the server sends it: the epoch rolled forward to the latest beat.
      return Beat.usable({ bpm: 128, epoch: t0 - 100 + Math.floor((at - t0 + 100) / (60000 / 128)) * (60000 / 128),
        phase: phase, confidence: 0.7, source: 'audio' }, at);
    };
    var first = beatAt(t0);
    assert.ok(first, 'the beat is taken');
    var once = Beat.follow(null, first, t0), polled = once;
    for (var t = t0; t < t0 + 10000; t += 10) {
      if ((t - t0) % 1000 === 0 && t > t0) polled = Beat.follow(polled, beatAt(t), t);
      assert.strictEqual(Beat.frameAt(polled, t, n), Beat.frameAt(once, t, n), 'the same frame at ' + (t - t0) + ' ms');
    }
  });
  console.log('  ✓ the same beat each second leaves the saver\'s frames as they were');
})();

try { fs.unlinkSync(pidFile); } catch (e) {}
assert.ok(!fs.existsSync(fifoPath), 'no real FIFO made');
fs.rmdirSync(dir);
console.log('test-auror-beat.js passed');
