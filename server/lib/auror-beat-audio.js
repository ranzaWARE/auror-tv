/*
 * lib/auror-beat-audio.js - the song's tempo and beat, heard from the TV's
 * own audio output, for Mimus in the AUROR screen saver (lib/auror-beat).
 *
 * The capture is ALSA's "Capture for dsnoop" device, the mix as heard, read
 * raw at 48 kHz stereo: resampling it in plughw cost 3-6% of a core on a C1
 * against 0.6% raw, so it is brought down to 12 kHz mono here instead.
 * docs/development/TV-RESEARCH.md, "Reading the audio output", has the
 * measurements behind every figure below.
 *
 * Samples are only ever held in memory, a few seconds at a time, and nothing
 * but the tempo and the beat's position leaves this module.
 *
 * Strict ES5: runs on node 0.12.
 */

var RATE_IN = 48000;
var DECIMATE = 4;
var RATE = RATE_IN / DECIMATE;
// Onset envelope: log energy over a 512-sample window, every 128 samples.
var WINDOW = 512;
var HOP = 128;
var FPS = RATE / HOP;
var ENVELOPE_S = 8;
var ENVELOPE_FRAMES = Math.round(ENVELOPE_S * FPS);
var ANALYSE_EVERY_S = 2;
var MIN_BPM = 80;
var MAX_BPM = 160;
var MIN_LAG = Math.floor(60 * FPS / MAX_BPM);
var MAX_LAG = Math.ceil(60 * FPS / MIN_BPM);
/*
 * The height of the autocorrelation peak did not tell a steady beat from none
 * (Clair de Lune's matched Blinding Lights'); the spread of the tempo over
 * six windows did: under 2.5% for every steady track, over 20% for the rest.
 */
var HISTORY = 6;
var MAX_SPREAD = 0.05;
var MIN_CONFIDENCE = 0.5;
// The published tempo moves only for a change this large, seen twice running.
var REPUBLISH_CHANGE = 0.02;
// How far past 80-160 a republished tempo may go to stay in the octave it was in.
var FOLD_SLACK = 1.25;
// Paused, the device reads digital zeros; a quarter second of them is silence.
var SILENT_SAMPLES = RATE / 4;

/**
 * The capture device as hw:card,device, from /proc/asound/pcm's text, or
 * null when it has no "Capture for dsnoop" capture. A line reads
 * `00-12: Capture for dsnoop snd-soc-dummy-dai-12 :  : capture 1`.
 * @param {string} text
 * @returns {string|null}
 */
function findCaptureDevice(text) {
  var lines = String(text || '').split('\n');
  for (var i = 0; i < lines.length; i++) {
    var m = /^(\d+)-(\d+):\s*Capture for dsnoop\b(.*)$/.exec(lines[i]);
    if (m && /:\s*capture\s+\d+/.test(m[3])) return 'hw:' + Number(m[1]) + ',' + Number(m[2]);
  }
  return null;
}

/**
 * A tempo folded into 80-160 BPM by octaves: a tracker may find half or
 * double the published tempo, and either moves Mimus the same.
 * @param {number} bpm
 * @returns {number}
 */
function fold(bpm) {
  if (!(bpm > 0) || !isFinite(bpm)) return bpm;
  while (bpm > MAX_BPM) bpm /= 2;
  while (bpm < MIN_BPM) bpm *= 2;
  return bpm;
}

// The peak's offset from b, between its neighbours a and c, by a parabola through the three.
function parabola(a, b, c) {
  var denom = a - 2 * b + c;
  if (denom >= 0) return 0;
  var d = 0.5 * (a - c) / denom;
  return d > 0.5 ? 0.5 : d < -0.5 ? -0.5 : d;
}

// env at a fractional index, linearly between its neighbours.
function at(env, x) {
  var i = Math.floor(x), f = x - i;
  if (i < 0 || i >= env.length) return 0;
  return i + 1 < env.length ? env[i] * (1 - f) + env[i + 1] * f : env[i];
}

/**
 * The tempo and the latest beat in one window of the onset envelope.
 * @param {number[]} env onset strength per hop, oldest first
 * @returns {{bpm: number, lag: number, beatsAgo: number}|null} lag in hops;
 *   beatsAgo, the hops from the newest frame back to the latest beat
 */
function analyse(env) {
  var n = env.length;
  if (n < MAX_LAG * 3) return null;
  var mean = 0, i;
  for (i = 0; i < n; i++) mean += env[i];
  mean /= n;
  var x = [];
  for (i = 0; i < n; i++) x.push(env[i] - mean);
  var r = {};
  for (var lag = MIN_LAG - 1; lag <= MAX_LAG + 1; lag++) {
    var s = 0;
    for (i = 0; i + lag < n; i++) s += x[i] * x[i + lag];
    r[lag] = s / (n - lag);
  }
  var best = MIN_LAG;
  for (lag = MIN_LAG + 1; lag <= MAX_LAG; lag++) if (r[lag] > r[best]) best = lag;
  if (!(r[best] > 0)) return null;
  var period = best + parabola(r[best - 1], r[best], r[best + 1]);

  // The beat: the offset back from the newest frame whose comb of beats a
  // period apart gathers the most onset strength.
  var steps = Math.ceil(period), score = [];
  for (var p = 0; p < steps; p++) {
    // Per tooth: the offsets nearer the newest frame fit one more in.
    var sum = 0, teeth = 0;
    for (var t = n - 1 - p; t >= 0; t -= period) { sum += at(env, t); teeth++; }
    score.push(teeth ? sum / teeth : 0);
  }
  var top = 0;
  for (p = 1; p < steps; p++) if (score[p] > score[top]) top = p;
  var ago = top + parabola(score[(top - 1 + steps) % steps], score[top], score[(top + 1) % steps]);
  if (ago < 0) ago += period;
  return { bpm: fold(60 * FPS / period), lag: period, beatsAgo: ago };
}

// A tempo's place within its octave, 0..1: 80 and 160 BPM are both 0.
function octavePlace(bpm) {
  var x = Math.log(bpm / MIN_BPM) / Math.LN2;
  return x - Math.floor(x);
}

/**
 * How far apart two tempos are as a fraction, an octave apart counting as
 * the same: 159 and 80.5 BPM are 1.3% apart.
 */
function octaveDistance(a, b) {
  var d = Math.abs(octavePlace(a) - octavePlace(b));
  return Math.pow(2, Math.min(d, 1 - d)) - 1;
}

/**
 * bpm, or its double or half, whichever is nearest to the tempo published
 * before, so a new tempo near 80 or 160 BPM never doubles or halves Mimus's
 * speed. Past 80-160 it stays within 64-200, inside the saver's 60-200.
 * @param {number} bpm in 80-160
 * @param {number} before
 * @returns {number}
 */
function nearestOctave(bpm, before) {
  var best = bpm;
  [bpm / 2, bpm * 2].forEach(function (c) {
    var inReach = c >= MIN_BPM / FOLD_SLACK && c <= MAX_BPM * FOLD_SLACK;
    if (inReach && Math.abs(Math.log(c / before)) < Math.abs(Math.log(best / before))) best = c;
  });
  return best;
}

/**
 * The tempo published from the last six windows: only when they agree.
 * They are compared within one octave, so a tempo near 80 or 160 BPM that
 * folds one way in one window and the other in the next still agrees.
 * @param {number[]} history window tempos, oldest first
 * @returns {{bpm: number, spread: number, confidence: number}|null}
 */
function stability(history) {
  if (history.length < HISTORY) return null;
  var places = history.slice(-HISTORY).map(octavePlace).sort(function (a, b) { return a - b; });
  // Cut the circle at its widest gap, and lay the places out from there.
  var cut = 0, gap = places[0] + 1 - places[HISTORY - 1];
  for (var i = 1; i < HISTORY; i++) {
    if (places[i] - places[i - 1] > gap) { gap = places[i] - places[i - 1]; cut = i; }
  }
  var line = places.slice(cut).concat(places.slice(0, cut).map(function (x) { return x + 1; }));
  var median = (line[HISTORY / 2 - 1] + line[HISTORY / 2]) / 2;
  var spread = Math.pow(2, line[HISTORY - 1] - line[0]) - 1;
  var confidence = Math.max(0, Math.min(1, 1 - spread / MAX_SPREAD));
  return { bpm: MIN_BPM * Math.pow(2, median - Math.floor(median)), spread: spread, confidence: confidence };
}

/**
 * Brings the capture's raw 48 kHz stereo S16_LE bytes down to 12 kHz mono
 * samples in -1..1: left and right averaged, then blocks of four. A stereo
 * frame, and a block, may be split across chunks.
 * @param {function(number): void} onSample
 * @returns {function(Buffer): void}
 */
function createDecimator(onSample) {
  var carry = [];
  var blockSum = 0, blockCount = 0;

  function frame(left, right) {
    blockSum += left + right;
    if (++blockCount < DECIMATE) return;
    onSample(blockSum / (2 * DECIMATE * 32768));
    blockSum = 0;
    blockCount = 0;
  }

  function int16(lo, hi) {
    var v = lo | (hi << 8);
    return v & 0x8000 ? v - 0x10000 : v;
  }

  return function (buf) {
    var off = 0;
    if (carry.length) {
      while (carry.length < 4 && off < buf.length) carry.push(buf[off++]);
      if (carry.length < 4) return;
      frame(int16(carry[0], carry[1]), int16(carry[2], carry[3]));
      carry = [];
    }
    for (; off + 4 <= buf.length; off += 4) frame(buf.readInt16LE(off), buf.readInt16LE(off + 2));
    while (off < buf.length) carry.push(buf[off++]);
  };
}

/**
 * Takes the capture's samples as they come and keeps the estimate up to
 * date: push() for the raw capture, pushSamples() for 12 kHz mono samples.
 */
function createTracker() {
  var ring = [], ringAt = 0, energy = 0;
  for (var w = 0; w < WINDOW; w++) ring.push(0);
  var env = [], hopCount = 0, hopZero = true, prevLog = null;
  var zeroRun = 0, silent = true;
  var sampleCount = 0, lastFrameAt = 0, sinceAnalysis = 0;
  var history = [], published = null, pendingChange = null, latest = null;
  // The tempo last published, kept through a stretch without one until silence, for its octave.
  var lastBpm = 0;

  function reset() {
    env = [];
    prevLog = null;
    history = [];
    published = null;
    pendingChange = null;
    latest = null;
    lastBpm = 0;
    sinceAnalysis = 0;
  }

  function update() {
    var a = analyse(env);
    if (!a) return;
    latest = { bpm: a.bpm, beatSample: lastFrameAt - a.beatsAgo * HOP - HOP / 2 };
    history.push(a.bpm);
    if (history.length > HISTORY) history.shift();
    var s = stability(history);
    if (!s || s.confidence < MIN_CONFIDENCE) {
      published = null;
      pendingChange = null;
      return;
    }
    if (published && octaveDistance(s.bpm, published.bpm) <= REPUBLISH_CHANGE) {
      pendingChange = null;
      published.confidence = s.confidence;
      return;
    }
    if (published && !pendingChange) {
      pendingChange = s.bpm;
      published.confidence = s.confidence;
      return;
    }
    pendingChange = null;
    published = { bpm: lastBpm ? nearestOctave(s.bpm, lastBpm) : s.bpm, confidence: s.confidence };
    lastBpm = published.bpm;
  }

  function frameEnded() {
    var lg = Math.log(Math.max(0, energy) / WINDOW + 1e-10);
    // The first hop after silence has nothing before it to rise from.
    var onset = prevLog === null ? 0 : Math.max(0, lg - prevLog);
    prevLog = lg;
    env.push(onset);
    if (env.length > ENVELOPE_FRAMES) env.shift();
    lastFrameAt = sampleCount;
    sinceAnalysis += HOP;
    if (env.length === ENVELOPE_FRAMES && sinceAnalysis >= ANALYSE_EVERY_S * RATE) {
      sinceAnalysis = 0;
      update();
    }
  }

  function sample(v) {
    sampleCount++;
    energy += v * v - ring[ringAt] * ring[ringAt];
    ring[ringAt] = v;
    ringAt = (ringAt + 1) % WINDOW;
    // Summed afresh once a second, so rounding in the running sum cannot build up.
    if (sampleCount % RATE === 0) {
      energy = 0;
      for (var i = 0; i < WINDOW; i++) energy += ring[i] * ring[i];
    }
    if (v !== 0) hopZero = false;
    if (++hopCount < HOP) return;
    hopCount = 0;
    if (hopZero) zeroRun += HOP;
    else zeroRun = 0;
    hopZero = true;
    if (zeroRun >= SILENT_SAMPLES) {
      if (!silent) reset();
      silent = true;
      return;
    }
    silent = false;
    frameEnded();
  }

  return {
    push: createDecimator(sample),
    /** @param {number[]} samples */
    pushSamples: function (samples) {
      for (var i = 0; i < samples.length; i++) sample(samples[i]);
    },
    // The decimated samples so far, the clock the beat's position is on.
    samples: function () { return sampleCount; },
    silent: function () { return silent; },
    /**
     * The published tempo and the latest beat heard, or null.
     * @returns {{bpm: number, confidence: number, beatSample: number}|null}
     */
    estimate: function () {
      if (silent || !published || !latest) return null;
      return { bpm: published.bpm, confidence: published.confidence, beatSample: latest.beatSample };
    }
  };
}

module.exports = {
  RATE: RATE,
  FPS: FPS,
  MIN_BPM: MIN_BPM,
  MAX_BPM: MAX_BPM,
  MIN_LAG: MIN_LAG,
  MAX_LAG: MAX_LAG,
  findCaptureDevice: findCaptureDevice,
  fold: fold,
  octaveDistance: octaveDistance,
  nearestOctave: nearestOctave,
  analyse: analyse,
  stability: stability,
  createDecimator: createDecimator,
  createTracker: createTracker
};
