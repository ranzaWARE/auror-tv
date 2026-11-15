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
var constants = require('constants');
var audio = require('./auror-beat-audio');
var allocBuffer = require('./util').allocBuffer;

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
var MKFIFO = 'mkfifo';
/*
 * arecord writes to this FIFO, which node drains every READ_MS. hw:0,12
 * grants a 512-frame period whatever is asked, and reading arecord's stdout
 * as a stream woke node 94 times a second: 4.1-4.3% of a core on the C1,
 * against 0.47% for this read every 100 ms, detector included
 * (TV-RESEARCH.md). 50 ms keeps most of the stream's margin before the
 * 64 KiB pipe fills (341 ms of audio) and arecord overruns the device.
 */
var FIFO = '/tmp/auror-beat-capture.fifo';
var READ_MS = 50;
var READ_BYTES = 65536;
/*
 * Read every 50 ms, a sample reaches node 0-11 ms after arecord has it
 * (p50 5.3 ms; as a stream, 0-1 ms). The delay is never negative, so the
 * least delayed read of the last 2 s places the beat as a stream would.
 */
var OFFSET_WINDOW_MS = 2000;
var OFFSET_SLOTS = 64;
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
 * From the beat in the samples to Mimus looking on it, in ms, tuned by eye on
 * a C1's speakers (webOS 6.5.3, Billie Jean at 117 BPM): -50 and 256 looked
 * off the beat, 0 to 180 on it, 150 best. The look's beatOffsetMs is added
 * to it, for speakers or headphones that add their own delay; null would
 * publish the tempo only (phase false).
 */
var OUTPUT_LATENCY_MS = 150;

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
var fifoPath = FIFO;
/** @type {any} */
var fileSystem = fs;
var readBuffer = null;

var tickTimer = null;
var device;        // undefined until looked for, then 'hw:C,D' or null
var lastPollAt = 0;
var lastMusic = null, lastMusicAt = 0;
/*
 * { token, child, startedAt, tracker, arrivedAt, fd, readTimer, fifoMade,
 *   offsetAt, offsets, offsetNext }: fd is the FIFO's read end, -1 when closed;
 *   offsetAt and offsets a ring of each read's time and its time less the
 *   samples read so far.
 */
var capture = null;
var respawnTimer = null;
var fastExits = 0;
var gaveUp = false;
var silentSince = 0;
var coolUntil = 0;
var silenceStops = 0;
var logged = '';
var exitHooked = false;
var kickOnPoll = true;

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
 * @param {string} [opts.fifo] for tests
 * @param {any} [opts.fs] for tests: openSync, readSync, fstatSync, closeSync, unlinkSync and writeFileSync
 * @param {number|null} [opts.outputLatencyMs] for tests, in place of OUTPUT_LATENCY_MS
 * @param {function(function(): void): void} [opts.onExit] for tests, in place of process.on('exit')
 * @param {boolean} [opts.noTick] for tests, which call tick() themselves
 * @param {boolean} [opts.noKick] for tests: a poll does not tick
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
  fifoPath = opts.fifo || FIFO;
  fileSystem = opts.fs || fs;
  device = undefined;
  lastPollAt = 0;
  lastMusic = null;
  lastMusicAt = 0;
  fastExits = 0;
  gaveUp = false;
  coolUntil = 0;
  silenceStops = 0;
  logged = '';
  kickOnPoll = !opts.noKick;
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

/**
 * Whether Home's settings have Mimus follow the beat.
 * @param {{mascots?: boolean, followBeat?: boolean}|null} look
 */
function followed(look) {
  return !!(look && look.mascots && look.followBeat !== false);
}

// Whether the capture should run now, all but the music asked synchronously.
function wanted(cb) {
  if (!home || !screensavers || gaveUp) return cb(false);
  // From Glasshouse Home a C1 (webOS 6.5.3) refused turnOnScreenSaver, and the saver
  // came up as an app with tvpower still Active (lib/screensavers trigger, Home's Test).
  var saverUp = home.screenSaverSince() || screensavers.launchedShowing();
  if (!saverUp || screensavers.screensaverMode() !== 'auror') return cb(false);
  if (nowMs() - lastPollAt > POLL_MS) return cb(false);
  if (!followed(home.layout().look)) return cb(false);
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
  try { fileSystem.unlinkSync(pidFile); } catch (e) {}
}

function closeQuiet(fd) {
  if (fd !== -1) try { fileSystem.closeSync(fd); } catch (e) {}
}

function stopReading(c) {
  clearInterval(c.readTimer);
  c.readTimer = null;
  closeQuiet(c.fd);
  c.fd = -1;
}

function closeCapture(c) {
  stopReading(c);
  if (c.fifoMade) try { fileSystem.unlinkSync(fifoPath); } catch (e) {}
  c.fifoMade = false;
}

function start() {
  killLeftover();
  var token = { cancelled: false };
  capture = { token: token, child: null, startedAt: 0, tracker: audio.createTracker(), arrivedAt: 0,
    fd: -1, readTimer: null, fifoMade: false,
    offsetAt: new Float64Array(OFFSET_SLOTS), offsets: new Float64Array(OFFSET_SLOTS), offsetNext: 0 };
  silentSince = 0;
  // children.launch cannot take a start back once queued: a stop meanwhile sets the flag instead.
  launch(function () {
    if (token.cancelled) return;
    // unlink removes a symlink itself, never what it points to. Node 0.12 has no mkfifo of its own.
    try { fileSystem.unlinkSync(fifoPath); } catch (e) {}
    var maker, done = false;
    function made(failed) {
      if (done) return;
      done = true;
      madeFifo(token, failed);
    }
    try {
      maker = spawnFn(MKFIFO, ['-m', '600', fifoPath], { stdio: 'ignore' });
    } catch (e) {
      return exited(token, 'could not make ' + fifoPath + ': ' + e.message);
    }
    maker.on('error', function (e) { made(e.message); });
    maker.on('exit', function (code, signal) { made(code === 0 ? null : signal || 'code ' + code); });
  });
}

function madeFifo(token, failed) {
  if (token.cancelled) {
    // Stopped while mkfifo ran. A capture started since unlinks the path itself before making its own.
    if (!failed && !capture) try { fileSystem.unlinkSync(fifoPath); } catch (e) {}
    return;
  }
  if (failed) return exited(token, 'could not make ' + fifoPath + ': ' + failed);
  capture.fifoMade = true;
  // arecord is a child start of its own, so it waits for its turn as well.
  launch(function () { if (!token.cancelled) spawnCapture(token); });
}

function spawnCapture(token) {
  var c = capture, writeFd = -1, child;
  try {
    // Non-blocking, so the open does not wait for a writer, and no read waits for data.
    c.fd = fileSystem.openSync(fifoPath, constants.O_RDONLY | constants.O_NONBLOCK | constants.O_NOFOLLOW);
    var st = fileSystem.fstatSync(c.fd);
    // /tmp is anyone's: what was opened must be the FIFO just made, not one put there in the meantime.
    if (!st.isFIFO() || st.uid !== process.getuid()) throw new Error(fifoPath + ' is not the FIFO made for the capture');
    // Through the read end's own fd, not the path: the same pipe whatever is
    // at the path by now, and with that reader open the open cannot block.
    writeFd = fileSystem.openSync(path.join(procDir, 'self', 'fd', String(c.fd)), constants.O_WRONLY);
    child = spawnFn(ARECORD, captureArgs(), { stdio: ['ignore', writeFd, 'ignore'] });
  } catch (e) {
    closeQuiet(writeFd);
    return exited(token, 'could not start: ' + e.message);
  }
  // arecord has its own copy: once it exits, a read gives 0.
  closeQuiet(writeFd);
  c.child = child;
  c.startedAt = nowMs();
  // Exclusive: /tmp is anyone's, and an existing file or symlink there is refused, not followed.
  if (child.pid) {
    try { fileSystem.writeFileSync(pidFile, String(child.pid), { flag: 'wx', mode: 420 }); } catch (e) {}
  }
  console.log('auror-beat: reading the audio output from ' + device);
  c.readTimer = setInterval(function () { drain(c); }, READ_MS);
  if (c.readTimer && c.readTimer.unref) c.readTimer.unref();
  child.on('error', function (e) { exited(token, e.message); });
  child.on('exit', function (code, signal) { exited(token, signal || 'code ' + code); });
}

// Reads what the FIFO holds, until it is empty.
function drain(c) {
  if (!readBuffer) readBuffer = allocBuffer(READ_BYTES);
  while (capture === c && c.fd !== -1) {
    var n;
    try {
      n = fileSystem.readSync(c.fd, readBuffer, 0, READ_BYTES, null);
    } catch (e) {
      if (e.code === 'EAGAIN' || e.code === 'EWOULDBLOCK') return;
      console.error('auror-beat: reading the capture failed: ' + e.message);
      stopReading(c);
      try { c.child.kill('SIGTERM'); } catch (e2) {}
      return;
    }
    // arecord closed its end: its exit ends the capture.
    if (n === 0) return stopReading(c);
    heard(readBuffer.slice(0, n), nowMs());
    if (n < READ_BYTES) return;
  }
}

function heard(buf, at) {
  var c = capture, t = c.tracker;
  t.push(buf);
  c.arrivedAt = at;
  c.offsetAt[c.offsetNext] = at;
  c.offsets[c.offsetNext] = at - t.samples() * 1000 / audio.RATE;
  c.offsetNext = (c.offsetNext + 1) % OFFSET_SLOTS;
  if (!t.silent()) {
    silentSince = 0;
    if (t.published()) silenceStops = 0;
    return;
  }
  if (!silentSince) silentSince = at;
  else if (at - silentSince >= SILENCE_STOP_MS) rest('30 s of silence');
}

// The least read delay over the last OFFSET_WINDOW_MS, as the read time less the time of the samples read.
function minOffset(c, now) {
  var min = Infinity;
  for (var i = 0; i < OFFSET_SLOTS; i++) {
    if (now - c.offsetAt[i] <= OFFSET_WINDOW_MS && c.offsets[i] < min) min = c.offsets[i];
  }
  return min;
}

// A capture that ran this long was not failing, however it ended.
function ranLong(c) {
  if (c.startedAt && nowMs() - c.startedAt >= FAST_EXIT_MS) fastExits = 0;
}

function exited(token, why) {
  if (token.cancelled || !capture || capture.token !== token) return;
  token.cancelled = true;
  ranLong(capture);
  closeCapture(capture);
  capture = null;
  try { fileSystem.unlinkSync(pidFile); } catch (e) {}
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
  closeCapture(capture);
  if (capture.child) {
    try { capture.child.kill('SIGTERM'); } catch (e) {}
    try { fileSystem.unlinkSync(pidFile); } catch (e) {}
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
  // The capture starts on the poll rather than up to 5 s later on the timer.
  if (kickOnPoll && !capture && !respawnTimer) tick();
}

// The TV's default plus the look's beatOffsetMs, read at each beat so a new offset counts without a restart.
function latencyMs() {
  if (typeof outputLatencyMs !== 'number') return null;
  var look = home && home.layout().look;
  return outputLatencyMs + (look && typeof look.beatOffsetMs === 'number' ? look.beatOffsetMs : 0);
}

/**
 * The beat for /api/home/look, or null.
 * provisional is a tempo heard for a few seconds only, which the next will refine.
 * @returns {{bpm: number, epoch: number, phase: boolean, confidence: number, source: string, provisional: boolean}|null}
 */
function beat() {
  var now = nowMs();
  var fresh = capture && capture.arrivedAt && now - capture.arrivedAt <= STALE_MS;
  var e = fresh ? capture.tracker.estimate() : null;
  var out = null;
  if (e) {
    var latency = latencyMs();
    var period = 60000 / e.bpm, phase = typeof latency === 'number';
    var heardAt = minOffset(capture, now) + e.beatSample * 1000 / audio.RATE;
    // Rolled forward to the latest beat, so a live one is never more than a period old.
    var rolled = heardAt + Math.floor((now - heardAt) / period) * period;
    out = { bpm: Math.round(e.bpm * 10) / 10, epoch: Math.round(rolled + (phase ? latency : 0)), phase: phase,
      confidence: Math.round(e.confidence * 100) / 100, source: 'audio', provisional: !!e.provisional };
  }
  var said = out ? out.bpm + ' BPM (' + out.source + (out.phase ? ', on the beat' : ', tempo only') +
    (out.provisional ? ', provisional' : '') + ')' : 'none';
  if (said !== logged) {
    if (logged || out) console.log('auror-beat: beat ' + said);
    logged = said;
  }
  return out;
}

module.exports = {
  init: init,
  followed: followed,
  tick: tick,
  polled: polled,
  beat: beat,
  stop: stop
};
