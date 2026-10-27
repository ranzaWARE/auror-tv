/*
 * lib/auror-tv.js - the TV's own controls on AUROR's Glasshouse Home: the
 * network's state behind the Wi-Fi button, the sleep timer and switching
 * off beside it, and SSH in its settings.
 *
 * The sleep timer runs here, not in the view, so it goes on while an app is
 * in front: a minute before, a toast says so, and the TV is switched off as
 * by its remote. Switched off before then, or by anything else, the timer is
 * cancelled, so it never switches off a TV turned on again since. Its end is
 * kept in auror-sleep.json, so a restart of the server (an update installed
 * at night) does not lose it.
 *
 * SSH is the Homebrew Channel's: its switch is a flag file its startup
 * script reads at boot, and dropbear, which it then starts. Here the flag
 * is set or cleared and dropbear started or stopped at once as well.
 *
 * Strict ES5: runs on node 0.12.
 */
var fs = require('fs');
var path = require('path');
var spawn = require('child_process').spawn;
var msg = require('./say').msg;
var util = require('./util');

// The timer button goes through these minutes, then off.
var SLEEP_STEPS = [30, 60, 90, 120];
var WARN_MS = 60000;
var NETWORK_TTL_MS = 15000;
var SSH_FLAG = '/var/luna/preferences/webosbrew_sshd_enabled';
var SSH_STATE_DIR = '/var/lib/webosbrew/sshd';
var DROPBEAR = '/media/developer/apps/usr/palm/services/org.webosbrew.hbchannel.service/bin/dropbear';

var luna = null;
var control = null;
var sshkeys = null;
var nowMs = Date.now;
var procDir = '/proc';
var sshFlag = SSH_FLAG;
var dropbear = DROPBEAR;
/** @type {any} */
var spawnFn = spawn;
var sleepFile = null;
var sshStateDir = SSH_STATE_DIR;
var killFn = function (pid, signal) { process.kill(pid, signal); };
var sleep = { at: 0, warn: null, off: null };
var network = { at: 0, value: null, waiting: null };

/**
 * @param {Object} opts
 * @param {function(string, Object, function(Object): void): void} opts.luna
 * @param {function(string, any, function(Object): void): void} opts.control doControl: 'toast' and 'powerOff'
 * @param {Object} [opts.sshkeys] lib/sshkeys, for whether dropbear runs and what lets in
 * @param {string} [opts.stateDir] where the sleep timer's end is kept
 * @param {function(): number} [opts.now] for tests
 * @param {string} [opts.procDir] for tests
 * @param {string} [opts.sshFlag] for tests
 * @param {string} [opts.dropbear] for tests
 * @param {Function} [opts.spawn] for tests
 * @param {string} [opts.sshStateDir] for tests
 * @param {function(number, string): void} [opts.kill] for tests
 */
function init(opts) {
  luna = opts.luna;
  control = opts.control;
  sshkeys = opts.sshkeys || null;
  nowMs = opts.now || Date.now;
  procDir = opts.procDir || '/proc';
  sshFlag = opts.sshFlag || SSH_FLAG;
  dropbear = opts.dropbear || DROPBEAR;
  spawnFn = opts.spawn || spawn;
  sshStateDir = opts.sshStateDir || SSH_STATE_DIR;
  if (opts.kill) killFn = opts.kill;
  network = { at: 0, value: null, waiting: null };
  clearTimeout(sleep.warn);
  clearTimeout(sleep.off);
  sleep = { at: 0, warn: null, off: null };
  sleepFile = opts.stateDir ? path.join(opts.stateDir, 'auror-sleep.json') : null;
  var kept = null;
  try { kept = JSON.parse(fs.readFileSync(sleepFile, 'utf8')); } catch (e) {}
  if (kept && typeof kept.at === 'number' && kept.at > nowMs() + 1000) {
    console.log('auror: sleep timer kept from before the restart');
    armSleep(kept.at);
  } else if (kept) {
    keepSleep();
  }
}

// ------------------------------------------------------------- network

/*
 * { kind: 'wifi' | 'wired' | 'none', state: 'online' | 'limited' | 'off',
 * ssid, ip }: limited is connected with no way out to the internet, as
 * behind a hotel's sign-in page. Kept 15 s: the view asks with its heartbeat.
 */
function networkStatus(cb) {
  if (!luna) return cb({ ok: false, kind: 'none', state: 'off', ssid: null, ip: null });
  if (network.value && nowMs() - network.at < NETWORK_TTL_MS) return cb(network.value);
  if (network.waiting) return network.waiting.push(cb);
  network.waiting = [cb];
  luna('com.palm.connectionmanager/getStatus', {}, function (r) {
    var wifi = (r && r.wifi) || {}, wired = (r && r.wired) || {};
    var kind = wired.state === 'connected' ? 'wired' : wifi.state === 'connected' ? 'wifi' : 'none';
    var link = kind === 'wired' ? wired : wifi;
    var online = r && (r.isInternetConnectionAvailable === true || link.onInternet === 'yes');
    var value = { ok: !!r, kind: kind, state: kind === 'none' ? 'off' : online ? 'online' : 'limited',
      ssid: kind === 'wifi' && wifi.ssid ? String(wifi.ssid) : null, ip: link.ipAddress ? String(link.ipAddress) : null };
    network.at = nowMs();
    network.value = value;
    var waiting = network.waiting;
    network.waiting = null;
    waiting.forEach(function (w) { w(value); });
  });
}

// ------------------------------------------------------------- sleep timer

function keepSleep() {
  if (!sleepFile) return;
  if (!sleep.at) return util.unlinkQuiet(sleepFile);
  try { util.writeJsonAtomic(sleepFile, { at: sleep.at }, 384); } catch (e) {}
}

function cancelSleep() {
  clearTimeout(sleep.warn);
  clearTimeout(sleep.off);
  sleep = { at: 0, warn: null, off: null };
  keepSleep();
}

// The toast a minute before the end, and switching off at it.
function armSleep(at) {
  var ms = at - nowMs();
  sleep.at = at;
  sleep.warn = setTimeout(function () {
    control('toast', msg('srv.auror.sleepWarn', 'The TV switches off in a minute. The timer on Home gives it longer.'), function () {});
  }, Math.max(0, ms - WARN_MS));
  sleep.off = setTimeout(function () {
    sleep = { at: 0, warn: null, off: null };
    keepSleep();
    console.log('auror: sleep timer switching the TV off');
    control('powerOff', null, function (r) {
      if (!r || !r.ok) console.error('auror: the sleep timer could not switch off: ' + ((r && r.error) || 'no answer'));
    });
  }, ms);
  keepSleep();
}

function sleepStatus() {
  var left = sleep.at ? Math.max(0, sleep.at - nowMs()) : 0;
  return { ok: true, minutes: left ? Math.ceil(left / 60000) : 0, left: left, at: sleep.at || null };
}

function setSleep(minutes) {
  cancelSleep();
  if (!control) return sleepStatus();
  minutes = Math.max(0, Math.min(240, Math.round(+minutes || 0)));
  if (!minutes) { console.log('auror: sleep timer off'); return sleepStatus(); }
  armSleep(nowMs() + minutes * 60000);
  console.log('auror: sleep timer ' + minutes + ' min');
  return sleepStatus();
}

// The next step from what is left: 30, 60, 90, 120 minutes, then off.
function nextSleep() {
  var left = sleepStatus().minutes;
  for (var i = 0; i < SLEEP_STEPS.length; i++) if (SLEEP_STEPS[i] > left) return setSleep(SLEEP_STEPS[i]);
  return setSleep(0);
}

// Switched off some other way: a TV turned on again is not switched off by an old timer.
function powerChanged(on) {
  if (!on && sleep.at) {
    console.log('auror: the TV went off, sleep timer cancelled');
    cancelSleep();
  }
}

function powerOff(cb) {
  if (!control) return cb({ ok: false, error: 'not ready' });
  cancelSleep();
  control('powerOff', null, function (r) { cb(r && r.ok ? { ok: true } : { ok: false, error: (r && r.error) || 'no answer' }); });
}

// ------------------------------------------------------------- SSH

function dropbearPids() {
  var out = [];
  var pids = [];
  try { pids = fs.readdirSync(procDir).filter(function (p) { return /^\d+$/.test(p); }); } catch (e) {}
  pids.forEach(function (p) {
    try { if (fs.readFileSync(path.join(procDir, p, 'comm'), 'utf8').trim() === 'dropbear') out.push(+p); } catch (e) {}
  });
  return out;
}

function sshStatus(cb) {
  var enabled = fs.existsSync(sshFlag), running = dropbearPids().length > 0;
  if (!sshkeys) return cb({ ok: true, enabled: enabled, running: running, keys: null, passwordNow: null });
  sshkeys.status(function (s) {
    cb({ ok: true, enabled: enabled, running: running, keys: s && s.keys ? s.keys.length : null,
      passwordNow: s ? s.passwordNow : null, passwordAfterReboot: s ? s.passwordAfterReboot : null });
  });
}

/*
 * On: the flag for the next boot, and dropbear now, as the Homebrew
 * Channel's startup script runs it. Off: no flag, and dropbear stopped,
 * which ends the SSH sessions open now as well.
 */
function setSsh(on, cb) {
  try {
    if (on) fs.writeFileSync(sshFlag, '1');
    else if (fs.existsSync(sshFlag)) fs.unlinkSync(sshFlag);
  } catch (e) {
    return cb({ ok: false, error: msg('srv.auror.sshFlag', 'could not change the Homebrew Channel\'s SSH setting: {error}', { error: e.message }) });
  }
  var pids = dropbearPids();
  if (on && !pids.length) {
    if (!fs.existsSync(dropbear)) {
      return cb({ ok: false, error: msg('srv.auror.sshMissing', 'the Homebrew Channel\'s dropbear is not on this TV') });
    }
    try {
      if (!fs.existsSync(sshStateDir)) fs.mkdirSync(sshStateDir);
    } catch (e) {}
    try {
      var child = spawnFn(dropbear, ['-R'], { detached: true, stdio: 'ignore' });
      if (child && child.unref) child.unref();
    } catch (e) {
      return cb({ ok: false, error: e.message });
    }
  }
  if (!on) pids.forEach(function (p) { try { killFn(p, 'SIGTERM'); } catch (e) {} });
  console.log('auror: SSH switched ' + (on ? 'on' : 'off'));
  setTimeout(function () { sshStatus(cb); }, 600);
}

module.exports = {
  init: init,
  networkStatus: networkStatus,
  sleepStatus: sleepStatus,
  setSleep: setSleep,
  nextSleep: nextSleep,
  powerChanged: powerChanged,
  powerOff: powerOff,
  sshStatus: sshStatus,
  setSsh: setSsh
};
