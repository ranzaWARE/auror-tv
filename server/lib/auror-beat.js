/*
 * lib/auror-beat.js - the beat Mimus follows in the AUROR screen saver: the
 * song's tempo and where its beat falls, as `beat` on /api/home/look.
 *
 * The audio is read (lib/auror-beat-audio) only while all of these hold:
 * LG's screen saver is up and it is AUROR's, a music app plays, Mimus and
 * following the beat are on in Home's settings, the TV is one where the
 * capture is known to work, and the saver has asked for the look in the last
 * 15 s, which is what proves it is on screen. A tick every 5 s starts and
 * stops the capture, so it ends without the saver's help.
 *
 * Strict ES5: runs on node 0.12.
 */
var fs = require('fs');
var path = require('path');
var spawn = require('child_process').spawn;
var audio = require('./auror-beat-audio');

/*
 * The webOS majors the capture is known to work on, each tried on a TV:
 * docs/development/TV-RESEARCH.md, "Reading the audio output". Spotify's
 * sound bypassed PulseAudio on webOS 6.5.3, and the device read can differ
 * on any other version.
 */
var WEBOS_MAJORS = [6];
var ARECORD = 'arecord';
var PCM_LIST = '/proc/asound/pcm';
var PID_FILE = '/tmp/auror-beat-capture.pid';
var TICK_MS = 5000;
var POLL_MS = 15000;
// An exit sooner than this after starting counts against the capture.
var FAST_EXIT_MS = 10000;
var BACKOFF_MS = [1000, 2000, 4000];
// Silence, or no sound from the capture at all, this long stops it for a rest.
var SILENCE_STOP_MS = 30000;
// The rest doubles after each stop for silence running, until a beat is heard again.
var SILENCE_COOL_MS = 60000;
var SILENCE_COOL_MAX_MS = 15 * 60000;
// Past this since the last sound arrived, the estimate is stale.
var STALE_MS = 1000;
// The saver asks every 5 s with the music's state already read.
var MUSIC_FRESH_MS = 5000;
/*
 * From the beat in the samples to the beat heard, in ms, calibrated in the
 * field on the TV's speakers. While it is null the beat's position is not
 * trusted: the tempo is published with phase false.
 */
var OUTPUT_LATENCY_MS = null;

/** @type {typeof import('./home')} */
var home = null;
/** @type {typeof import('./screensavers')} */
var screensavers = null;
var webosVersion = null;
var children = require('./children');
var launch = children.launch;
/** @type {any} */
var spawnFn = spawn;
var nowMs = Date.now;
function readFileUtf8(f) { return fs.readFileSync(f, 'utf8'); }
function killPid(pid, signal) { process.kill(pid, signal); }
var readFile = readFileUtf8;
var killFn = killPid;
var outputLatencyMs = OUTPUT_LATENCY_MS;
var pcmList = PCM_LIST;
var pidFile = PID_FILE;
var procDir = '/proc';

var tickTimer = null;
var device;        // undefined until looked for, then 'hw:C,D' or null
var lastPollAt = 0;
var lastMusic = null, lastMusicAt = 0;
var capture = null;  // { token, child, startedAt, tracker, arrivedAt, arrivedSamples }
var respawnTimer = null;
var fastExits = 0;
var gaveUp = false;
var silentSince = 0;
var coolUntil = 0;
var silenceStops = 0;
var logged = '';
var exitHooked = false;

/**
 * @param {Object} opts
 * @param {typeof import('./home')} opts.home
 * @param {typeof import('./screensavers')} opts.screensavers
 * @param {string|null} opts.webosVersion as the TV reports it
 * @param {function(function(): void): void} [opts.launch] lib/children's, for tests
 * @param {Function} [opts.spawn] for tests
 * @param {function(): number} [opts.now] for tests
 * @param {function(string): string} [opts.readFile] for tests
 * @param {function(number, string): void} [opts.kill] for tests
 * @param {string} [opts.pcmList] for tests
 * @param {string} [opts.pidFile] for tests
 * @param {string} [opts.procDir] for tests
 * @param {number|null} [opts.outputLatencyMs] for tests, in place of OUTPUT_LATENCY_MS
 * @param {function(function(): void): void} [opts.onExit] for tests, in place of process.on('exit')
 * @param {boolean} [opts.noTick] for tests, which call tick() themselves
 */
function init(opts) {
  stop();
  home = opts.home || null;
  screensavers = opts.screensavers || null;
  webosVersion = opts.webosVersion || null;
  launch = opts.launch || children.launch;
  spawnFn = opts.spawn || spawn;
  nowMs = opts.now || Date.now;
  readFile = opts.readFile || readFileUtf8;
  killFn = opts.kill || killPid;
  outputLatencyMs = opts.outputLatencyMs !== undefined ? opts.outputLatencyMs : OUTPUT_LATENCY_MS;
  pcmList = opts.pcmList || PCM_LIST;
  pidFile = opts.pidFile || PID_FILE;
  procDir = opts.procDir || '/proc';
  device = undefined;
  lastPollAt = 0;
  lastMusic = null;
  lastMusicAt = 0;
  fastExits = 0;
  gaveUp = false;
  coolUntil = 0;
  silenceStops = 0;
  logged = '';
  clearInterval(tickTimer);
  tickTimer = opts.noTick ? null : setInterval(tick, TICK_MS);
  if (tickTimer && tickTimer.unref) tickTimer.unref();
  if (opts.onExit) opts.onExit(killChild);
  else if (!exitHooked) {
    exitHooked = true;
    // tvweb's SIGTERM and SIGINT handlers end in process.exit, so this runs for them too.
    process.on('exit', function () { killChild(); });
  }
}

// ------------------------------------------------------------- when

function webosAllowed() {
  var major = parseInt(String(webosVersion || ''), 10);
  return WEBOS_MAJORS.indexOf(major) !== -1;
}

function captureDevice() {
  if (device === undefined) {
    var text = '';
    try { text = readFile(pcmList); } catch (e) {}
    device = audio.findCaptureDevice(text);
    if (!device) console.log('auror-beat: no "Capture for dsnoop" device, Mimus keeps his own tempo');
  }
  return device;
}

// Whether the capture should run now, all but the music asked synchronously.
function wanted(cb) {
  if (!home || !screensavers || gaveUp) return cb(false);
  if (!home.screenSaverSince() || screensavers.screensaverMode() !== 'auror') return cb(false);
  if (nowMs() - lastPollAt > POLL_MS) return cb(false);
  var look = home.layout().look;
  if (!look || !look.mascots || look.followBeat === false) return cb(false);
  if (!webosAllowed() || !captureDevice()) return cb(false);
  if (!home.musicApp()) return cb(false);
  if (lastMusic !== null && nowMs() - lastMusicAt < MUSIC_FRESH_MS) return cb(lastMusic);
  home.musicPlaying(function (music) { cb(!!music); });
}

function tick() {
  wanted(function (yes) {
    if (!yes) {
      if (capture || respawnTimer) stop();
      return;
    }
    // A capture that has stopped giving anything at all rests as for silence.
    if (capture && capture.child && nowMs() - (capture.arrivedAt || capture.startedAt) >= SILENCE_STOP_MS) {
      return rest('no sound from the capture for 30 s');
    }
    if (capture || respawnTimer || nowMs() < coolUntil) return;
    start();
  });
}

function rest(why) {
  var ms = Math.min(SILENCE_COOL_MAX_MS, SILENCE_COOL_MS * Math.pow(2, silenceStops));
  silenceStops++;
  console.log('auror-beat: ' + why + ', the capture rests ' + ms / 1000 + ' s');
  stop();
  coolUntil = nowMs() + ms;
}

// ------------------------------------------------------------- capture

function captureArgs() {
  return ['-q', '-D', device, '-c', '2', '-f', 'S16_LE', '-r', '48000', '-t', 'raw'];
}

/*
 * A capture left running by a server that did not get to stop it: killed
 * only when its command line is exactly the capture's, as the pid may since
 * have gone to any of LG's processes.
 */
function killLeftover() {
  var pid = 0;
  try { pid = parseInt(readFile(pidFile), 10); } catch (e) { return; }
  var cmdline = '';
  try { cmdline = readFile(path.join(procDir, String(pid), 'cmdline')); } catch (e) {}
  if (pid > 0 && cmdline === [ARECORD].concat(captureArgs()).join('\u0000') + '\u0000') {
    try { killFn(pid, 'SIGTERM'); } catch (e) {}
    console.log('auror-beat: stopped a capture left from before');
  }
  try { fs.unlinkSync(pidFile); } catch (e) {}
}

function start() {
  killLeftover();
  var token = { cancelled: false };
  capture = { token: token, child: null, startedAt: 0, tracker: audio.createTracker(), arrivedAt: 0, arrivedSamples: 0 };
  silentSince = 0;
  // children.launch cannot take a start back once queued: a stop meanwhile sets the flag instead.
  launch(function () {
    if (token.cancelled) return;
    var child;
    try {
      child = spawnFn(ARECORD, captureArgs(), { stdio: ['ignore', 'pipe', 'ignore'] });
    } catch (e) {
      return exited(token, 'could not start: ' + e.message);
    }
    capture.child = child;
    capture.startedAt = nowMs();
    // Exclusive: /tmp is anyone's, and an existing file or symlink there is refused, not followed.
    if (child.pid) {
      try { fs.writeFileSync(pidFile, String(child.pid), { flag: 'wx', mode: 420 }); } catch (e) {}
    }
    console.log('auror-beat: reading the audio output from ' + device);
    child.stdout.on('data', function (buf) { if (!token.cancelled) heard(buf); });
    child.on('error', function (e) { exited(token, e.message); });
    child.on('exit', function (code, signal) { exited(token, signal || 'code ' + code); });
  });
}

function heard(buf) {
  var t = capture.tracker;
  t.push(buf);
  capture.arrivedAt = nowMs();
  capture.arrivedSamples = t.samples();
  if (!t.silent()) {
    silentSince = 0;
    if (t.estimate()) silenceStops = 0;
    return;
  }
  if (!silentSince) silentSince = capture.arrivedAt;
  else if (capture.arrivedAt - silentSince >= SILENCE_STOP_MS) rest('30 s of silence');
}

// A capture that ran this long was not failing, however it ended.
function ranLong(c) {
  if (c.startedAt && nowMs() - c.startedAt >= FAST_EXIT_MS) fastExits = 0;
}

function exited(token, why) {
  if (token.cancelled || !capture || capture.token !== token) return;
  token.cancelled = true;
  ranLong(capture);
  capture = null;
  try { fs.unlinkSync(pidFile); } catch (e) {}
  if (fastExits >= BACKOFF_MS.length) {
    gaveUp = true;
    console.error('auror-beat: the capture keeps ending (' + why + '), given up until the server restarts');
    return;
  }
  var wait = BACKOFF_MS[fastExits++];
  console.error('auror-beat: the capture ended (' + why + '), again in ' + wait / 1000 + ' s');
  respawnTimer = setTimeout(function () {
    respawnTimer = null;
    tick();
  }, wait);
}

function killChild() {
  if (!capture) return;
  capture.token.cancelled = true;
  ranLong(capture);
  if (capture.child) {
    try { capture.child.kill('SIGTERM'); } catch (e) {}
    try { fs.unlinkSync(pidFile); } catch (e) {}
  }
  capture = null;
}

function stop() {
  clearTimeout(respawnTimer);
  respawnTimer = null;
  if (!capture) return;
  killChild();
  console.log('auror-beat: stopped reading the audio output');
}

// ------------------------------------------------------------- the beat

/**
 * The saver asked for the look: it is on screen.
 * @param {boolean} [music] whether music plays, as just read for the reply
 */
function polled(music) {
  lastPollAt = nowMs();
  if (typeof music === 'boolean') {
    lastMusic = music;
    lastMusicAt = lastPollAt;
  }
}

/**
 * The beat for /api/home/look, or null.
 * @returns {{bpm: number, epoch: number, phase: boolean, confidence: number, source: string}|null}
 */
function beat() {
  var now = nowMs();
  var fresh = capture && capture.arrivedAt && now - capture.arrivedAt <= STALE_MS;
  var e = fresh ? capture.tracker.estimate() : null;
  var out = null;
  if (e) {
    var period = 60000 / e.bpm, phase = typeof outputLatencyMs === 'number';
    var heardAt = capture.arrivedAt - (capture.arrivedSamples - e.beatSample) * 1000 / audio.RATE;
    // Rolled forward to the latest beat, so a live one is never more than a period old.
    var rolled = heardAt + Math.floor((now - heardAt) / period) * period;
    out = { bpm: Math.round(e.bpm * 10) / 10, epoch: Math.round(rolled + (phase ? outputLatencyMs : 0)), phase: phase,
      confidence: Math.round(e.confidence * 100) / 100, source: 'audio' };
  }
  var said = out ? out.bpm + ' BPM (' + out.source + (out.phase ? ', on the beat' : ', tempo only') + ')' : 'none';
  if (said !== logged) {
    if (logged || out) console.log('auror-beat: beat ' + said);
    logged = said;
  }
  return out;
}

module.exports = {
  init: init,
  tick: tick,
  polled: polled,
  beat: beat,
  stop: stop
};
