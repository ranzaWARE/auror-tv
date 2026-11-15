#!/usr/bin/env node
/*
 * scripts/beat-replay.js - replays captured or generated audio through
 * lib/auror-beat-audio's tracker and reports what it publishes and when.
 * A dev tool, not deployed. Strict ES5, so it also runs on the TV's node.
 *
 *   node scripts/beat-replay.js [options] input...
 *   node scripts/beat-replay.js [options] --manifest <corpus>/manifest.tsv
 *   node scripts/beat-replay.js [options] --synthetic
 *
 * An input is a raw capture (48 kHz stereo S16_LE, as arecord gives it) with
 * its reference tempo: file.raw[:bpm|unknown|unsteady]. Inputs joined by +
 * play as one track, a track change: a.raw:117+b.raw:124, and
 * a.raw:117+gap+b.raw:124 with half a second of digital zeros between.
 * manifest.tsv rows: name, bpm or unknown, steady y|n, optional steadyFrom
 * seconds; names are relative to the manifest's folder.
 *
 * Options:
 *   --module <path>      the auror-beat-audio.js to replay (default: this repo's)
 *   --runs <n>           push() timing runs, the median is reported (default 5)
 *   --dump-env <out>     each hop's onset and window energy, and each
 *                        analysis's decision, as JSON (needs a module that
 *                        takes an observer in createTracker)
 *
 * Times are seconds of audio fed, counted at the end of the chunk after which
 * the tracker was read, as lib/auror-beat reads it after each chunk.
 */
var fs = require('fs');
var path = require('path');
var allocBuffer = require('../server/lib/util').allocBuffer;

var BYTES_PER_S = 48000 * 4;
var GAP_S = 0.5;
var WITHIN = 0.02;
// What Mimus can live with early: the saver puts him back on the beat each second, so a tempo this near holds.
var COARSE = 0.05;

function usage(why) {
  if (why) console.error(why);
  console.error('usage: beat-replay.js [--module path] [--runs n] [--dump-env out.json] ' +
    '(--manifest manifest.tsv | --synthetic | file.raw[:bpm|unknown|unsteady][+gap][+file.raw...]...)');
  process.exit(2);
}

var opts = { module: path.join(__dirname, '..', 'server', 'lib', 'auror-beat-audio.js'), runs: 5, dump: null,
  manifest: null, synthetic: false, inputs: [] };
(function () {
  var args = process.argv.slice(2);
  for (var i = 0; i < args.length; i++) {
    var a = args[i];
    if (a === '--module') opts.module = path.resolve(args[++i] || usage('--module needs a path'));
    else if (a === '--runs') opts.runs = Math.max(1, parseInt(args[++i], 10) || usage('--runs needs a number'));
    else if (a === '--dump-env') opts.dump = args[++i] || usage('--dump-env needs a path');
    else if (a === '--manifest') opts.manifest = args[++i] || usage('--manifest needs a path');
    else if (a === '--synthetic') opts.synthetic = true;
    else if (a.charAt(0) === '-') usage('unknown option ' + a);
    else opts.inputs.push(a);
  }
  if (!opts.manifest && !opts.synthetic && !opts.inputs.length) usage();
})();

var audio = require(opts.module);
var RATE = audio.RATE;

// ---- tempo maths, kept here so any version of the module can be replayed

function octavePlace(bpm) {
  var x = Math.log(bpm / 80) / Math.LN2;
  return x - Math.floor(x);
}

// Apart as a fraction, an octave apart counting as the same.
function octaveDistance(a, b) {
  var d = Math.abs(octavePlace(a) - octavePlace(b));
  return Math.pow(2, Math.min(d, 1 - d)) - 1;
}

// ---- inputs: a case is one track of raw bytes and the segments it was joined from

/**
 * @typedef {{start: number, end: number, name: string, ref: number|null, steady: boolean, steadyFrom: number}} Segment
 * @typedef {{name: string, buf: Buffer, segments: Segment[]}} Case
 */

/**
 * @param {{name: string, buf: Buffer, ref: number|null, steady: boolean, steadyFrom: number}[]} parts
 * @returns {Case}
 */
function join(parts) {
  var segments = [], at = 0;
  parts.forEach(function (p) {
    var s = p.buf.length / BYTES_PER_S;
    segments.push({ start: at, end: at + s, name: p.name, ref: p.ref, steady: p.steady, steadyFrom: p.steadyFrom || 0 });
    at += s;
  });
  return {
    name: parts.map(function (p) { return p.name; }).join('+'),
    buf: Buffer.concat(parts.map(function (p) { return p.buf; })),
    segments: segments
  };
}

function gapPart() {
  return { name: 'gap', buf: allocBuffer(GAP_S * BYTES_PER_S), ref: null, steady: false, steadyFrom: 0 };
}

// file.raw[:bpm|unknown|unsteady]
function filePart(spec, dir) {
  var m = /^(.*?)(?::([0-9.]+|unknown|unsteady))?$/.exec(spec);
  var file = path.resolve(dir || '.', m[1]);
  var ref = m[2] && m[2] !== 'unknown' && m[2] !== 'unsteady' ? Number(m[2]) : null;
  return { name: path.basename(file, '.raw'), buf: fs.readFileSync(file), ref: ref, steady: m[2] !== 'unsteady', steadyFrom: 0 };
}

function fromArgument(arg) {
  return join(arg.split('+').map(function (spec) { return spec === 'gap' ? gapPart() : filePart(spec); }));
}

function fromManifest(file) {
  var dir = path.dirname(file), cases = [];
  fs.readFileSync(file, 'utf8').split('\n').forEach(function (line) {
    var cols = line.replace(/\r$/, '').split('\t');
    if (!cols[0] || cols[0].charAt(0) === '#' || cols[0] === 'name') return;
    var name = /\.raw$/.test(cols[0]) ? cols[0] : cols[0] + '.raw';
    var p = filePart(name, dir);
    p.ref = cols[1] && cols[1] !== 'unknown' ? Number(cols[1]) : null;
    p.steady = cols[2] !== 'n';
    p.steadyFrom = Number(cols[3]) || 0;
    cases.push(join([p]));
  });
  return cases;
}

// ---- synthetic cases: the click tracks of test/test-auror-beat.js, at 48 kHz stereo

var seed = 7;
function random() { seed = (seed * 16807) % 2147483647; return seed / 2147483647; }

/*
 * A click track at 12 kHz: a short decaying tone every beat over white
 * noise. intervalAt(t) gives the beat's length at t seconds, for one that wanders.
 */
function clicks(bpm, seconds, noise, intervalAt) {
  var out = [], next = 0.1 * RATE;
  for (var i = 0; i < seconds * RATE; i++) {
    var v = (random() * 2 - 1) * noise, d = i - next;
    if (d >= 0 && d < 240) v += 0.6 * Math.exp(-d / 40) * Math.sin(d * 0.7);
    if (d >= 240) next += Math.round((intervalAt ? intervalAt(i / RATE) : 60 / bpm) * RATE);
    out.push(v);
  }
  return out;
}

function noise(seconds, level) {
  var out = [];
  for (var i = 0; i < seconds * RATE; i++) out.push((random() * 2 - 1) * level);
  return out;
}

// 12 kHz mono as the capture would give it: each sample four times, both channels.
function raw(samples) {
  var buf = allocBuffer(samples.length * 16);
  for (var i = 0; i < samples.length; i++) {
    var v = Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767)));
    for (var j = 0; j < 4; j++) {
      buf.writeInt16LE(v, (i * 4 + j) * 4);
      buf.writeInt16LE(v, (i * 4 + j) * 4 + 2);
    }
  }
  return buf;
}

function part(name, samples, ref, steady) {
  return { name: name, buf: raw(samples), ref: ref, steady: steady, steadyFrom: 0 };
}

function syntheticCases() {
  return [
    join([part('steady-120', clicks(120, 30, 0.05), 120, true)]),
    join([part('clicks-100', clicks(100, 20, 0.05), 100, true), part('clicks-140', clicks(140, 25, 0.05), 140, true)]),
    join([part('clicks-120', clicks(120, 20, 0.05), 120, true), gapPart(), part('clicks-120', clicks(120, 20, 0.05), 120, true)]),
    // 108 to 132 BPM and back every 12 s.
    join([part('wandering', clicks(120, 30, 0.05, function (s) { return 0.5 / (1 + 0.1 * Math.sin(s * Math.PI / 6)); }), null, false)]),
    // +-6% at 0.1 Hz.
    join([part('rubato', clicks(120, 40, 0.05, function (s) { return 0.5 / (1 + 0.06 * Math.sin(2 * Math.PI * 0.1 * s)); }), null, false)]),
    // 120 with a 4 s bridge in 3:2, three beats in the time of two.
    join([part('steady-120', clicks(120, 14, 0.05), 120, true), part('bridge-3:2', clicks(180, 4, 0.05), 120, true),
      part('steady-120', clicks(120, 14, 0.05), 120, true)]),
    join([part('noise', noise(25, 0.3), null, false)]),
    join([part('zeros', noise(25, 0), null, false)])
  ];
}

// ---- replay

// Odd chunk sizes, so frames and blocks split across chunks.
function chunks(buf) {
  var out = [];
  for (var pos = 0, n = 0; pos < buf.length; n++) {
    var len = 4093 + (n % 7);
    out.push(buf.slice(pos, Math.min(buf.length, pos + len)));
    pos += len;
  }
  return out;
}

function segmentAt(c, t) {
  for (var i = 0; i < c.segments.length; i++) if (t < c.segments[i].end) return c.segments[i];
  return c.segments[c.segments.length - 1];
}

function replay(c, dump) {
  var observer = null;
  if (dump) {
    observer = {
      hop: function (onset, energy) { dump.hops.push([onset, energy]); },
      analysed: function (sample, bpm, published) {
        dump.analyses.push([sample, bpm, published ? published.bpm : null, published ? published.confidence : null]);
      }
    };
  }
  var tr = audio.createTracker(observer);
  var r = { firstPublish: null, firstConfirmed: null, firstWithin: null, firstCoarse: null, firstError: null, provisionalS: 0, jumps: 0,
    publishedS: 0, refS: 0, withinS: 0, unsteadyS: 0, transitions: 0, log: [], relock: [] };
  var pos = 0, prev = null, logged, seen = c.segments[0], ref = seen.ref;
  chunks(c.buf).forEach(function (chunk) {
    tr.push(chunk);
    var dt = chunk.length / BYTES_PER_S;
    pos += chunk.length;
    var t = pos / BYTES_PER_S, seg = segmentAt(c, t - dt / 2);
    var e = tr.estimate(), bpm = e ? e.bpm : null;
    // A new song: a new reference tempo, or any after a gap.
    if (seg !== seen) {
      if (seg.ref && (seg.ref !== ref || seen.name === 'gap')) r.relock.push({ name: seg.name, at: seg.start, after: null });
      if (seg.ref) ref = seg.ref;
      seen = seg;
    }
    var pending = r.relock.length && r.relock[r.relock.length - 1];
    if (e) {
      if (r.firstPublish === null) r.firstPublish = t;
      if (r.firstConfirmed === null && !e.provisional) r.firstConfirmed = t;
      r.publishedS += dt;
      if (e.provisional) r.provisionalS += dt;
      // Past 1.4 apart is a jump of octave, not a refinement.
      if (prev !== null && Math.max(bpm, prev) / Math.min(bpm, prev) > 1.4) r.jumps++;
      if (seg.ref && seg.steady && r.firstError === null) r.firstError = octaveDistance(bpm, seg.ref);
      if (seg.ref && seg.steady && r.firstCoarse === null && octaveDistance(bpm, seg.ref) <= COARSE) r.firstCoarse = t;
      if (seg.ref && seg.steady && r.firstWithin === null && octaveDistance(bpm, seg.ref) <= WITHIN) r.firstWithin = t;
      if (!seg.steady) r.unsteadyS += dt;
      else if (seg.ref && t - seg.start >= seg.steadyFrom) {
        r.refS += dt;
        if (octaveDistance(bpm, seg.ref) <= WITHIN) r.withinS += dt;
      }
      if (pending && pending.after === null && seg.ref && octaveDistance(bpm, seg.ref) <= WITHIN) pending.after = t - pending.at;
    }
    if ((prev === null) !== (bpm === null)) r.transitions++;
    var said = e ? bpm.toFixed(1) + (e.provisional ? ' provisional' : '') : 'null';
    if (said !== logged && (logged !== undefined || e)) r.log.push(t.toFixed(1) + ' s ' + said);
    logged = said;
    prev = bpm;
  });
  return r;
}

// push() alone, in µs per second of audio: the median of several runs.
function pushCost(c, runs) {
  var list = chunks(c.buf), times = [];
  for (var k = 0; k < runs; k++) {
    var tr = audio.createTracker(), t0 = process.hrtime();
    for (var i = 0; i < list.length; i++) tr.push(list[i]);
    var dt = process.hrtime(t0);
    times.push((dt[0] * 1e6 + dt[1] / 1e3) / (c.buf.length / BYTES_PER_S));
  }
  times.sort(function (a, b) { return a - b; });
  return times[Math.floor(times.length / 2)];
}

function seconds(x) { return x === null ? '-' : x.toFixed(1) + ' s'; }

var cases = [];
if (opts.synthetic) cases = cases.concat(syntheticCases());
if (opts.manifest) cases = cases.concat(fromManifest(opts.manifest));
cases = cases.concat(opts.inputs.map(fromArgument));

var dumps = {};
console.log('module ' + opts.module);
// The first tempo near the true one on each steady track with a tempo, for the summary.
var firsts = { firstCoarse: [], firstWithin: [] };
cases.forEach(function (c) {
  var dump = opts.dump ? { hops: [], analyses: [] } : null;
  var r = replay(c, dump);
  if (dump) dumps[c.name] = dump;
  if (c.segments.length === 1 && c.segments[0].ref && c.segments[0].steady) {
    Object.keys(firsts).forEach(function (k) { firsts[k].push(r[k] === null ? Infinity : r[k]); });
  }
  var steady = c.segments.some(function (s) { return s.steady && s.ref; });
  var unsteady = c.segments.some(function (s) { return !s.steady && s.name !== 'gap'; });
  var parts = [
    'first ' + seconds(r.firstPublish),
    'confirmed ' + seconds(r.firstConfirmed)
  ];
  if (steady) parts.push('within 2% ' + (r.refS ? (100 * r.withinS / r.refS).toFixed(1) + '%' : '-'));
  if (unsteady) parts.push('unsteady published ' + r.unsteadyS.toFixed(1) + ' s');
  if (steady) parts.push('first within 5% ' + seconds(r.firstCoarse) + ', within 2% ' + seconds(r.firstWithin) + ', first off by ' +
    (r.firstError === null ? '-' : (100 * r.firstError).toFixed(1) + '%'));
  if (r.provisionalS) parts.push('provisional ' + r.provisionalS.toFixed(1) + ' s');
  if (r.jumps) parts.push('octave jumps ' + r.jumps);
  parts.push('null/beat ' + r.transitions);
  r.relock.forEach(function (x) { parts.push('relock ' + x.name + ' ' + seconds(x.after)); });
  parts.push('push ' + pushCost(c, opts.runs).toFixed(0) + ' µs/s');
  console.log(c.name + ' (' + (c.buf.length / BYTES_PER_S).toFixed(1) + ' s): ' + parts.join(', '));
  console.log('  ' + (r.log.length ? r.log.join(' | ') : 'publishes nothing'));
});
[['firstCoarse', '5%'], ['firstWithin', '2%']].forEach(function (k) {
  var list = firsts[k[0]].sort(function (a, b) { return a - b; });
  if (list.length > 1) {
    console.log('first within ' + k[1] + ' over ' + list.length + ' steady tracks with a tempo: median ' +
      seconds(list[Math.floor((list.length - 1) / 2)]) + ', p90 ' + seconds(list[Math.ceil(0.9 * list.length) - 1]));
  }
});
if (opts.dump) fs.writeFileSync(opts.dump, JSON.stringify({ module: opts.module, cases: dumps }));
