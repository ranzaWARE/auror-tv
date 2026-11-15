/*
 * test/test-qmlcheck.js - the server's check of a screen saver's QML against
 * the QtQuick it imports and the TV's own (lib/qmlcheck), for AnimatedImage's
 * speed and webOS 6.
 *
 * Strict ES5: runs on node 0.12.
 */
var assert = require('assert');
var qmlcheck = require('../server/lib/qmlcheck');

console.log('Running test-qmlcheck.js ...');

var flagged = qmlcheck.problem('import QtQuick 2.4\nItem {\n    AnimatedImage { speed: 2 }\n}\n', 'main.qml', 9);
assert.ok(flagged && /speed needs QtQuick 2\.11/.test(flagged), 'speed under QtQuick 2.4: ' + flagged);
assert.strictEqual(qmlcheck.problem('import QtQuick 2.4\nItem {\n    property real speed: 2\n}\n', 'main.qml', 9), null,
  'a speed property the saver declares itself');
assert.strictEqual(qmlcheck.problem('import QtQuick 2.12\nItem {\n}\n', 'main.qml', 6), null, 'QtQuick 2.12 on webOS 6');
assert.strictEqual(qmlcheck.QTQUICK_BY_WEBOS[6], 12);
console.log('  ✓ speed needs QtQuick 2.11, a property of its own is not flagged, webOS 6 has 2.12');

console.log('test-qmlcheck.js passed');
