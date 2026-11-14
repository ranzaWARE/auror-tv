/*
 * Mimus on the beat: which frame of his GIF to show, from the beat the server
 * hears (lib/auror-beat). Imported by main.qml beside it and required by
 * test/test-auror-beat.js, so plain ES5 with no QML in it.
 *
 * Each GIF is four frames, two to a beat, drawn at 120 BPM; frames 0 and 2
 * fall on the beat. The saver keeps its own anchor, a time a beat fell on,
 * and moves it toward the server's only by easing, so Mimus never jumps.
 *
 * A state is { bpm, anchor, from, shift, easeStart, easeMs }: while easing,
 * the anchor is from + shift * eased progress.
 */

// Under this, a difference between the saver's beat and the server's is left alone.
var SLACK_MS = 40;
var EASE_BEATS = 4;
var MAX_AGE_MS = 10000;

// The server's beat when it can be followed, else null and the GIF plays at its own 120 BPM.
function usable(beat, now) {
    if (!beat || typeof beat !== "object") return null;
    if (typeof beat.bpm !== "number" || !(beat.bpm >= 60 && beat.bpm <= 200)) return null;
    if (typeof beat.epoch !== "number" || !isFinite(beat.epoch)) return null;
    if (!(beat.confidence >= 0.5)) return null;
    if (Math.abs(now - beat.epoch) > MAX_AGE_MS) return null;
    return beat;
}

function halfBeatMs(bpm) { return 30000 / bpm; }

function anchorAt(state, now) {
    if (!state.easeMs) return state.anchor;
    var p = Math.min(1, Math.max(0, (now - state.easeStart) / state.easeMs));
    return state.from + state.shift * p * p * (3 - 2 * p);
}

/*
 * The frame at now: k half-beats since the anchor. An anchor after now (the
 * server adds the output's latency to the beat it heard) gives a negative k,
 * hence the double modulo.
 */
function frameAt(state, now, frames) {
    var k = Math.floor((now - anchorAt(state, now)) / halfBeatMs(state.bpm));
    return ((k % frames) + frames) % frames;
}

// Milliseconds to the next half-beat, when the frame next changes.
function untilNext(state, now) {
    var half = halfBeatMs(state.bpm);
    var into = (now - anchorAt(state, now)) % half;
    if (into < 0) into += half;
    return Math.max(1, Math.ceil(half - into));
}

// The difference from the anchor to target, by the nearest beat either way.
function offBy(anchor, target, bpm) {
    var period = 60000 / bpm;
    var d = (target - anchor) % period;
    if (d > period / 2) d -= period;
    if (d < -period / 2) d += period;
    return d;
}

/*
 * The state after a new beat from the server. A new tempo is taken at the
 * place Mimus has reached, so his frame does not jump. With phase, the
 * anchor then eases to the server's beat over four beats when the two are
 * more than 40 ms apart; without, the server's epoch is a guess and is
 * not used.
 */
function follow(state, beat, now) {
    if (!state) return { bpm: beat.bpm, anchor: beat.phase ? beat.epoch : now, from: 0, shift: 0, easeStart: 0, easeMs: 0 };
    var anchor = anchorAt(state, now);
    var easing = state.easeMs && now - state.easeStart < state.easeMs;
    if (beat.bpm !== state.bpm) {
        var at = (now - anchor) / halfBeatMs(state.bpm);
        anchor = now - at * halfBeatMs(beat.bpm);
        easing = false;
    }
    var next = { bpm: beat.bpm, anchor: anchor, from: 0, shift: 0, easeStart: 0, easeMs: 0 };
    if (!beat.phase) return next;
    // An ease under way to near the same beat carries on.
    if (easing && Math.abs(offBy(state.from + state.shift, beat.epoch, beat.bpm)) <= SLACK_MS) return state;
    var d = offBy(anchor, beat.epoch, beat.bpm);
    if (Math.abs(d) <= SLACK_MS) return next;
    next.from = anchor;
    next.shift = d;
    next.easeStart = now;
    next.easeMs = EASE_BEATS * 60000 / beat.bpm;
    return next;
}

if (typeof module !== "undefined") module.exports = {
    SLACK_MS: SLACK_MS,
    EASE_BEATS: EASE_BEATS,
    usable: usable,
    anchorAt: anchorAt,
    frameAt: frameAt,
    untilNext: untilNext,
    offBy: offBy,
    follow: follow
};
