/*
 * lib/auror-wake.js - Wake-on-LAN for the computer Steam streams from: opening
 * the Steam Link tile (Moonlight) on AUROR's Glasshouse Home first sends that
 * computer a magic packet, so it wakes as Moonlight looks for it.
 *
 * The computer's MAC address is set once from the dashboard, typed or found
 * from its address while it is on (the TV's ARP table has it once a packet
 * has gone its way). Kept in auror-wake.json.
 *
 * The packet goes to the network's broadcast address, to 255.255.255.255 and
 * to the computer's last address, on ports 9 and 7: routers and network cards
 * differ in which they pass on.
 *
 * Strict ES5: runs on node 0.12 (0.10 on webOS 2).
 */
var fs = require('fs');
var os = require('os');
var path = require('path');
var dgramModule = require('dgram');
var util = require('./util');
var msg = require('./say').msg;

var CONFIG_FILE = 'auror-wake.json';
var ARP_FILE = '/proc/net/arp';
var PORTS = [9, 7];
// After a packet to the address, how long the kernel is given to resolve it.
var ARP_WAIT_MS = 600;
var MAC = /^([0-9a-f]{2})[:\-]?([0-9a-f]{2})[:\-]?([0-9a-f]{2})[:\-]?([0-9a-f]{2})[:\-]?([0-9a-f]{2})[:\-]?([0-9a-f]{2})$/i;
var IP4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

var stateDir = '/var/lib/tvweb';
var dgram = dgramModule;
var arpFile = ARP_FILE;
var interfacesFn = function () { try { return os.networkInterfaces() || {}; } catch (e) { return {}; } };
/** @type {function(Function, number): any} */
var setTimer = setTimeout;
var control = null;
var cfg = null;

/**
 * @param {Object} opts
 * @param {string} opts.stateDir
 * @param {any} [opts.dgram] for tests
 * @param {string} [opts.arpFile] for tests
 * @param {function(): Object} [opts.interfaces] for tests
 * @param {function(Function, number): any} [opts.setTimeout] for tests
 * @param {function(string, any, function(Object): void): void} [opts.control] doControl, for the TV's toast
 */
function init(opts) {
  stateDir = opts.stateDir;
  dgram = opts.dgram || dgramModule;
  arpFile = opts.arpFile || ARP_FILE;
  interfacesFn = opts.interfaces || interfacesFn;
  setTimer = opts.setTimeout || setTimeout;
  control = opts.control || null;
  cfg = null;
}

function file() { return path.join(stateDir, CONFIG_FILE); }

// As aa:bb:cc:dd:ee:ff, from any of the usual ways of writing one; null if it is not one.
function normaliseMac(s) {
  var m = MAC.exec(String(s || '').trim());
  if (!m) return null;
  var mac = m.slice(1).join(':').toLowerCase();
  // All zeros is an ARP entry still resolving; all ones, broadcast.
  return mac === '00:00:00:00:00:00' || mac === 'ff:ff:ff:ff:ff:ff' ? null : mac;
}

function validIp(s) {
  var m = IP4.exec(String(s || '').trim());
  if (!m) return null;
  for (var i = 1; i <= 4; i++) if (+m[i] > 255) return null;
  return m.slice(1).map(Number).join('.');
}

function config() {
  if (cfg) return cfg;
  var raw = util.readJson(file(), null) || {};
  cfg = { mac: normaliseMac(raw.mac), ip: validIp(raw.ip) };
  return cfg;
}

function status() {
  var c = config();
  return { ok: true, configured: !!c.mac, mac: c.mac, ip: c.ip };
}

// From the dashboard: { mac, ip }, either emptied with ''.
function save(body, cb) {
  body = body || {};
  var c = config(), next = { mac: c.mac, ip: c.ip };
  if (body.mac !== undefined) {
    next.mac = body.mac === '' || body.mac === null ? null : normaliseMac(body.mac);
    if (body.mac && !next.mac) return cb({ ok: false, error: msg('srv.wake.badMac', 'That is not a MAC address: six pairs of hex digits, as 3c:7c:3f:12:ab:cd.') });
  }
  if (body.ip !== undefined) {
    next.ip = body.ip === '' || body.ip === null ? null : validIp(body.ip);
    if (body.ip && !next.ip) return cb({ ok: false, error: msg('srv.wake.badIp', 'That is not an IPv4 address.') });
  }
  try { util.writeJsonAtomic(file(), next); } catch (e) { return cb({ ok: false, error: e.message }); }
  cfg = null;
  cb(status());
}

// The MAC the TV's ARP table has for an address, or null.
function arpMac(ip) {
  var text = '';
  try { text = fs.readFileSync(arpFile, 'utf8'); } catch (e) { return null; }
  var lines = text.split('\n');
  for (var i = 1; i < lines.length; i++) {
    var cols = lines[i].trim().split(/\s+/);
    // IP address, HW type, Flags (0x0 is incomplete), HW address, Mask, Device.
    if (cols[0] === ip && cols[2] !== '0x0') return normaliseMac(cols[3]);
  }
  return null;
}

function magicPacket(mac) {
  var bytes = mac.split(':').map(function (h) { return parseInt(h, 16); });
  var buf = util.allocBuffer(6 + 16 * 6);
  for (var i = 0; i < 6; i++) buf[i] = 255;
  for (var r = 0; r < 16; r++) for (var k = 0; k < 6; k++) buf[6 + r * 6 + k] = bytes[k];
  return buf;
}

// node 0.12 gives the family as 'IPv4', later versions as 4.
function isIPv4(entry) { return String(entry.family) === 'IPv4' || String(entry.family) === '4'; }

// The broadcast address of each IPv4 network the TV is on: node 0.10 gives no netmask, so /24 then.
function broadcasts() {
  var out = [], ifaces = interfacesFn();
  for (var name in ifaces) {
    if (!ifaces.hasOwnProperty(name)) continue;
    (ifaces[name] || []).forEach(function (e) {
      if (!isIPv4(e) || e.internal) return;
      var ip = e.address.split('.').map(Number);
      var mask = (e.netmask || '255.255.255.0').split('.').map(Number);
      var b = ip.map(function (o, i) { return (o | (~mask[i] & 255)) & 255; }).join('.');
      if (out.indexOf(b) === -1) out.push(b);
    });
  }
  return out;
}

// Sends each packet in turn on one socket, then closes it: cb(error or null, sent).
function sendAll(buf, targets, cb) {
  var sock = null, sent = 0, done = false;
  function finish(err) {
    if (done) return;
    done = true;
    try { sock.close(); } catch (e) {}
    cb(err || null, sent);
  }
  try { sock = dgram.createSocket('udp4'); } catch (e) { return cb(e, 0); }
  sock.on('error', function (err) { finish(err); });
  sock.bind(0, function () {
    try { sock.setBroadcast(true); } catch (e) {}
    var i = 0;
    (function next() {
      if (i >= targets.length) return finish(sent ? null : new Error('nothing sent'));
      var t = targets[i++];
      // node 0.10's send takes the offset and length.
      sock.send(buf, 0, buf.length, t.port, t.host, function (err) {
        if (!err) sent++;
        next();
      });
    })();
  });
}

// The magic packet to the computer set, cb({ ok, sent }).
function wake(cb) {
  var c = config();
  if (!c.mac) return cb({ ok: false, error: msg('srv.wake.none', 'No computer is set to wake.') });
  var hosts = broadcasts().concat(['255.255.255.255']);
  if (c.ip && hosts.indexOf(c.ip) === -1) hosts.push(c.ip);
  var targets = [];
  hosts.forEach(function (h) { PORTS.forEach(function (p) { targets.push({ host: h, port: p }); }); });
  sendAll(magicPacket(c.mac), targets, function (err, sent) {
    if (err && !sent) return cb({ ok: false, error: err.message });
    console.log('auror-wake: magic packet for ' + c.mac + ' to ' + hosts.join(', '));
    cb({ ok: true, sent: sent });
  });
}

/*
 * The MAC of the computer at an address, while it is on: a packet sent its
 * way has the kernel resolve it, then the ARP table has it.
 */
function find(ip, cb) {
  ip = validIp(ip);
  if (!ip) return cb({ ok: false, error: msg('srv.wake.badIp', 'That is not an IPv4 address.') });
  var known = arpMac(ip);
  if (known) return cb({ ok: true, mac: known, ip: ip });
  sendAll(util.allocBuffer(1), [{ host: ip, port: 9 }], function () {
    setTimer(function () {
      var mac = arpMac(ip);
      if (!mac) return cb({ ok: false, error: msg('srv.wake.notFound', 'Nothing answered at {ip}. The computer must be on, and on the same network as the TV.', { ip: ip }) });
      cb({ ok: true, mac: mac, ip: ip });
    }, ARP_WAIT_MS);
  });
}

// Moonlight, AUROR's Steam Link tile: Moonlight TV for webOS is com.limelight.webos.
function isStreamApp(app) {
  return !!app && (/^com\.limelight\./.test(String(app.id || '')) || /^moonlight( tv)?$/i.test(String(app.title || '')));
}

/*
 * Before an app opens: the magic packet first when it streams from the
 * computer set, and the TV's toast saying so, as Moonlight shows the computer
 * offline until it is up.
 */
function beforeOpen(app, cb) {
  if (!isStreamApp(app) || !config().mac) return cb(false);
  wake(function (r) {
    if (r.ok && control) control('toast', { text: msg('srv.wake.toast', 'Waking the computer for Steam Link…') }, function () {});
    cb(!!r.ok);
  });
}

module.exports = {
  init: init, status: status, save: save, find: find, wake: wake, beforeOpen: beforeOpen,
  isStreamApp: isStreamApp, normaliseMac: normaliseMac, magicPacket: magicPacket, broadcasts: broadcasts, arpMac: arpMac
};
