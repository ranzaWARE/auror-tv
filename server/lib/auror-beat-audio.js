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
var HOPS_PER_WINDOW = WINDOW / HOP;
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
// Four stereo frames of 16-bit samples summed make one sample in -1..1.
var SCALE = 2 * DECIMATE * 32768;

// analyse()'s working space, reused: it runs every 2 s for as long as the capture does.
var analyseX = new Float64Array(ENVELOPE_FRAMES);
var analyseR = new Float64Array(MAX_LAG + 2);
var analyseScore = new Float64Array(MAX_LAG + 2);

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

/**
 * env at a fractional index, linearly between its neighbours.
 * @param {ArrayLike<number>} env
 * @param {number} x
 */
function at(env, x) {
  var i = Math.floor(x), f = x - i;
  if (i < 0 || i >= env.length) return 0;
  return i + 1 < env.length ? env[i] * (1 - f) + env[i + 1] * f : env[i];
}

/**
 * The tempo and the latest beat in one window of the onset envelope.
 * @param {ArrayLike<number>} env onset strength per hop, oldest first
 * @returns {{bpm: number, lag: number, beatsAgo: number}|null} lag in hops;
 *   beatsAgo, the hops from the newest frame back to the latest beat
 */
function analyse(env) {
  var n = env.length;
  if (n < MAX_LAG * 3) return null;
  var mean = 0, i;
  for (i = 0; i < n; i++) mean += env[i];
  mean /= n;
  if (analyseX.length < n) analyseX = new Float64Array(n);
  var x = analyseX, r = analyseR, score = analyseScore;
  for (i = 0; i < n; i++) x[i] = env[i] - mean;
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
  var steps = Math.ceil(period);
  for (var p = 0; p < steps; p++) {
    // Per tooth: the offsets nearer the newest frame fit one more in.
    var sum = 0, teeth = 0;
    for (var t = n - 1 - p; t >= 0; t -= period) { sum += at(env, t); teeth++; }
    score[p] = teeth ? sum / teeth : 0;
  }
  var top = 0;
  for (p = 1; p < steps; p++) if (score[p] > score[top]) top = p;
  var ago = top + parabola(score[(top - 1 + steps) % steps], score[top], score[(top + 1) % steps]);
  if (ago < 0) ago += period;
  return { bpm: fold(60 * FPS / period), lag: period, beatsAgo: ago };
}

/**
 * A tempo's place within its octave, 0..1: 80 and 160 BPM are both 0.
 * @param {number} bpm
 */
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
 * @param {ArrayLike<number>} history window tempos, oldest first
 * @returns {{bpm: number, spread: number, confidence: number}|null}
 */
function stability(history) {
  var n = history.length;
  if (n < HISTORY) return null;
  var places = [];
  for (var k = n - HISTORY; k < n; k++) places.push(octavePlace(history[k]));
  places.sort(function (a, b) { return a - b; });
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
 * Takes the capture's samples as they come and keeps the estimate up to
 * date: push() for the raw capture, pushSamples() for 12 kHz mono samples.
 * observer, for scripts/beat-replay.js and the tests, sees each hop's onset
 * and window energy and each analysis's decision; the server passes none.
 * @param {{hop: function(number, number): void,
 *   analysed: function(number, number|null, {bpm: number, confidence: number}|null): void}} [observer]
 */
function createTracker(observer) {
  // The raw capture, brought down to 12 kHz mono: left and right summed over
  // blocks of four frames. A frame (up to 3 bytes carried) and a block may be
  // split across chunks.
  var carried = 0, carry0 = 0, carry1 = 0, carry2 = 0;
  var blockSum = 0, blockCount = 0;
  // The hop in progress: its samples, their sum of squares, and whether all were zero.
  var hopCount = 0, hopSquares = 0, hopZero = true;
  // The window's energy is the sum of its last four hops'.
  var hopEnergy = new Float64Array(HOPS_PER_WINDOW), hopAt = 0;
  // The onset envelope, a ring; copied out oldest first for analyse().
  var env = new Float64Array(ENVELOPE_FRAMES), envAt = 0, envCount = 0;
  var envOrdered = new Float64Array(ENVELOPE_FRAMES);
  var prevLog = null;
  var zeroRun = 0, silent = true;
  var sampleCount = 0, lastFrameAt = 0, sinceAnalysis = 0;
  var history = [], published = null, pendingChange = null, latest = null, lastAnalysis = null;
  // The tempo last published, kept through a stretch without one until silence, for its octave.
  var lastBpm = 0;

  function reset() {
    envAt = 0;
    envCount = 0;
    prevLog = null;
    history = [];
    published = null;
    pendingChange = null;
    latest = null;
    lastBpm = 0;
    sinceAnalysis = 0;
  }

  function update() {
    for (var i = 0; i < ENVELOPE_FRAMES; i++) envOrdered[i] = env[(envAt + i) % ENVELOPE_FRAMES];
    var a = analyse(envOrdered);
    lastAnalysis = a;
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
    var energy = 0;
    for (var i = 0; i < HOPS_PER_WINDOW; i++) energy += hopEnergy[i];
    var lg = Math.log(energy / WINDOW + 1e-10);
    // The first hop after silence has nothing before it to rise from.
    var onset = prevLog === null ? 0 : Math.max(0, lg - prevLog);
    prevLog = lg;
    env[envAt] = onset;
    envAt = (envAt + 1) % ENVELOPE_FRAMES;
    if (envCount < ENVELOPE_FRAMES) envCount++;
    if (observer) observer.hop(onset, energy / WINDOW);
    lastFrameAt = sampleCount;
    sinceAnalysis += HOP;
    if (envCount === ENVELOPE_FRAMES && sinceAnalysis >= ANALYSE_EVERY_S * RATE) {
      sinceAnalysis = 0;
      update();
      if (observer) observer.analysed(lastFrameAt, lastAnalysis && lastAnalysis.bpm, published);
    }
  }

  /**
   * A hop of HOP samples has ended. Its energy joins the window's even in
   * silence, so the first window after it holds only what was heard.
   * @param {number} squares the hop's sum of squares
   * @param {boolean} zero whether every sample in it was zero
   */
  function hopEnded(squares, zero) {
    sampleCount += HOP;
    hopEnergy[hopAt] = squares;
    hopAt = (hopAt + 1) % HOPS_PER_WINDOW;
    if (zero) zeroRun += HOP;
    else zeroRun = 0;
    if (zeroRun >= SILENT_SAMPLES) {
      if (!silent) reset();
      silent = true;
      return;
    }
    silent = false;
    frameEnded();
  }

  function keep(b) {
    if (carried === 0) carry0 = b;
    else if (carried === 1) carry1 = b;
    else carry2 = b;
    carried++;
  }

  /**
   * The raw capture: 48 kHz stereo S16_LE, split anywhere. One pass over the
   * bytes, with no call per frame or sample: at 192 000 bytes a second this
   * loop is most of the capture's cost on the TV.
   * @param {Buffer} buf
   */
  function push(buf) {
    var n = buf.length, i = 0;
    var sum = blockSum, count = blockCount, hc = hopCount, squares = hopSquares, zero = hopZero;
    if (carried) {
      if (carried + n < 4) {
        for (; i < n; i++) keep(buf[i]);
        return;
      }
      // Read in order: each buf[i++] takes the next byte.
      var b1 = carried > 1 ? carry1 : buf[i++];
      var b2 = carried > 2 ? carry2 : buf[i++];
      var b3 = buf[i++];
      sum += ((carry0 | b1 << 8) << 16 >> 16) + ((b2 | b3 << 8) << 16 >> 16);
      count++;
      carried = 0;
    }
    // A finished block is taken at the top, so one from the carried frame is
    // too. A block with all its 16 bytes in this chunk is summed at once.
    for (;; i += 4) {
      if (count === DECIMATE) {
        var v = sum / SCALE;
        sum = 0;
        count = 0;
        squares += v * v;
        if (v !== 0) zero = false;
        if (++hc === HOP) {
          hopEnded(squares, zero);
          hc = 0;
          squares = 0;
          zero = true;
        }
      }
      // Little-endian 16-bit, sign-extended.
      if (count === 0 && i + 16 <= n) {
        sum = ((buf[i] | buf[i + 1] << 8) << 16 >> 16) + ((buf[i + 2] | buf[i + 3] << 8) << 16 >> 16) +
          ((buf[i + 4] | buf[i + 5] << 8) << 16 >> 16) + ((buf[i + 6] | buf[i + 7] << 8) << 16 >> 16) +
          ((buf[i + 8] | buf[i + 9] << 8) << 16 >> 16) + ((buf[i + 10] | buf[i + 11] << 8) << 16 >> 16) +
          ((buf[i + 12] | buf[i + 13] << 8) << 16 >> 16) + ((buf[i + 14] | buf[i + 15] << 8) << 16 >> 16);
        count = DECIMATE;
        i += 12;
        continue;
      }
      if (i + 4 > n) break;
      sum += ((buf[i] | buf[i + 1] << 8) << 16 >> 16) + ((buf[i + 2] | buf[i + 3] << 8) << 16 >> 16);
      count++;
    }
    for (; i < n; i++) keep(buf[i]);
    blockSum = sum;
    blockCount = count;
    hopCount = hc;
    hopSquares = squares;
    hopZero = zero;
  }

  return {
    push: push,
    /** @param {ArrayLike<number>} samples */
    pushSamples: function (samples) {
      var hc = hopCount, squares = hopSquares, zero = hopZero;
      for (var i = 0; i < samples.length; i++) {
        var v = samples[i];
        squares += v * v;
        if (v !== 0) zero = false;
        if (++hc === HOP) {
          hopEnded(squares, zero);
          hc = 0;
          squares = 0;
          zero = true;
        }
      }
      hopCount = hc;
      hopSquares = squares;
      hopZero = zero;
    },
    // The decimated samples so far, the clock the beat's position is on.
    samples: function () { return sampleCount + hopCount; },
    silent: function () { return silent; },
    // Whether a tempo is published: estimate() without making one.
    published: function () { return !silent && !!published && !!latest; },
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
  createTracker: createTracker
};
