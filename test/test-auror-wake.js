/* The computer Steam Link wakes (lib/auror-wake): its MAC set or found in the
 * ARP table, the magic packet to every broadcast address on ports 9 and 7,
 * and only before Moonlight opens. A fake dgram records what is sent.
 * Strict ES5: also runs on node 0.10. */
var assert = require('assert');
var fs = require('fs');
var os = require('os');
var path = require('path');
var wake = require('../server/lib/auror-wake');

console.log('Running test-auror-wake.js ...');

var dir = path.join(os.tmpdir(), 'auror-wake-' + process.pid);
fs.mkdirSync(dir);
var arp = path.join(dir, 'arp');
var ARP_HEAD = 'IP address       HW type     Flags       HW address            Mask     Device\n';
fs.writeFileSync(arp, ARP_HEAD);

var sent = [], sockets = 0, closed = 0, broadcast = false, timers = [], toasts = [];
var fakeDgram = {
  createSocket: function (type) {
    assert.strictEqual(type, 'udp4');
    sockets++;
    return {
      on: function () {},
      bind: function (port, cb) { cb(); },
      setBroadcast: function (on) { broadcast = on; },
      send: function (buf, offset, length, port, host, cb) {
        sent.push({ buf: buf.slice(offset, offset + length), port: port, host: host });
        // A host that answers in the ARP table once anything is sent its way.
        if (host === '192.168.100.48') fs.writeFileSync(arp, ARP_HEAD + '192.168.100.48   0x1         0x2         3c:7c:3f:12:ab:cd     *        eth0\n');
        cb(null);
      },
      close: function () { closed++; }
    };
  }
};

function reset() {
  sent = []; timers = []; toasts = [];
  wake.init({
    stateDir: dir, dgram: fakeDgram, arpFile: arp,
    interfaces: function () {
      return { lo: [{ family: 'IPv4', address: '127.0.0.1', netmask: '255.0.0.0', internal: true }],
               eth0: [{ family: 'IPv4', address: '192.168.100.117', netmask: '255.255.255.0', internal: false }],
               wlan0: [{ family: 4, address: '10.1.2.3', internal: false }] };
    },
    setTimeout: function (fn, ms) { timers.push({ fn: fn, ms: ms }); },
    control: function (cmd, value, cb) { toasts.push({ cmd: cmd, value: value }); cb({ ok: true }); }
  });
}

function call(fn) {
  var out = null;
  var args = Array.prototype.slice.call(arguments, 1);
  fn.apply(null, args.concat([function (r) { out = r; }]));
  return out;
}

try {
  reset();
  assert.strictEqual(wake.normaliseMac('3C-7C-3F-12-AB-CD'), '3c:7c:3f:12:ab:cd');
  assert.strictEqual(wake.normaliseMac('3c7c.3f12.abcd'), null, 'Cisco dots are not taken');
  assert.strictEqual(wake.normaliseMac('3c7c3f12abcd'), '3c:7c:3f:12:ab:cd');
  assert.strictEqual(wake.normaliseMac('00:00:00:00:00:00'), null, 'an incomplete ARP entry is no MAC');
  var packet = wake.magicPacket('01:02:03:04:05:06');
  assert.strictEqual(packet.length, 102);
  for (var i = 0; i < 6; i++) assert.strictEqual(packet[i], 255);
  assert.strictEqual(packet[6 + 15 * 6 + 5], 6, 'the MAC sixteen times');
  assert.deepEqual(wake.broadcasts(), ['192.168.100.255', '10.1.2.255'], 'each network\'s broadcast, /24 without a netmask');
  console.log('  ✓ MACs, the magic packet and the broadcast addresses');

  assert.strictEqual(call(wake.wake).ok, false, 'nothing to wake before a MAC is set');
  assert.strictEqual(call(wake.save, { mac: 'not a mac' }).ok, false);
  assert.strictEqual(call(wake.save, { ip: '300.1.1.1' }).ok, false);
  var saved = call(wake.save, { mac: '3C:7C:3F:12:AB:CD', ip: '192.168.100.48' });
  assert.strictEqual(saved.configured, true);
  assert.strictEqual(saved.mac, '3c:7c:3f:12:ab:cd');
  reset();
  assert.deepEqual(wake.status(), { ok: true, configured: true, mac: '3c:7c:3f:12:ab:cd', ip: '192.168.100.48' }, 'kept on disk');
  console.log('  ✓ the MAC and address are checked and kept');

  var woke = call(wake.wake);
  assert.strictEqual(woke.ok, true);
  assert.strictEqual(broadcast, true, 'the socket may broadcast');
  var hosts = sent.map(function (s) { return s.host + ':' + s.port; });
  assert.deepEqual(hosts, ['192.168.100.255:9', '192.168.100.255:7', '10.1.2.255:9', '10.1.2.255:7',
    '255.255.255.255:9', '255.255.255.255:7', '192.168.100.48:9', '192.168.100.48:7']);
  assert.strictEqual(sent[0].buf[6], 0x3c);
  assert.strictEqual(closed, sockets, 'the socket is closed');
  console.log('  ✓ the packet goes to each broadcast address and the computer on ports 9 and 7');

  reset();
  var later = null;
  wake.beforeOpen({ id: 'com.netflix.app', title: 'Netflix' }, function (w) { later = w; });
  assert.strictEqual(later, false);
  assert.strictEqual(sent.length, 0, 'no packet for another app');
  wake.beforeOpen({ id: 'com.limelight.webos', title: 'Moonlight' }, function (w) { later = w; });
  assert.strictEqual(later, true);
  assert.strictEqual(sent.length, 8);
  assert.strictEqual(toasts.length, 1, 'the TV says the computer is being woken');
  assert.strictEqual(toasts[0].cmd, 'toast');
  assert.strictEqual(wake.isStreamApp({ id: 'x.y', title: 'Moonlight TV' }), true, 'by its title too');
  call(wake.save, { mac: '' });
  wake.beforeOpen({ id: 'com.limelight.webos', title: 'Moonlight' }, function (w) { later = w; });
  assert.strictEqual(later, false, 'with no computer set Moonlight just opens');
  console.log('  ✓ only Moonlight wakes the computer, and only once one is set');

  reset();
  fs.writeFileSync(arp, ARP_HEAD + '192.168.100.9    0x1         0x0         00:00:00:00:00:00     *        eth0\n');
  var found = call(wake.find, '192.168.100.48');
  assert.strictEqual(found, null, 'waits for the kernel to resolve the address');
  assert.strictEqual(sent[0].host, '192.168.100.48', 'a packet goes its way first');
  timers[0].fn();
  found = null;
  wake.find('192.168.100.48', function (r) { found = r; });
  assert.deepEqual(found, { ok: true, mac: '3c:7c:3f:12:ab:cd', ip: '192.168.100.48' }, 'then in the ARP table at once');
  var missing = null;
  wake.find('192.168.100.9', function (r) { missing = r; });
  timers[timers.length - 1].fn();
  assert.strictEqual(missing.ok, false, 'an incomplete entry is nothing found');
  assert.strictEqual(call(wake.find, 'pc.local').ok, false, 'an address, not a name');
  console.log('  ✓ the MAC is found from the computer\'s address while it is on');
} finally {
  fs.readdirSync(dir).forEach(function (f) { fs.unlinkSync(path.join(dir, f)); });
  fs.rmdirSync(dir);
}

console.log('ALL test-auror-wake.js assertions passed!');
