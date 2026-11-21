/* The song for the AUROR screen saver (lib/auror-song): the first active media
 * session's title and artist, kept four seconds, and nothing asked again of a
 * TV without the service. Strict ES5: also runs on node 0.10. */
var assert = require('assert');
var song = require('../server/lib/auror-song');

console.log('Running test-auror-song.js ...');

var now = 1000, calls = [], replies = {};
function luna(uri, params, cb) {
  calls.push(uri + ' ' + JSON.stringify(params));
  cb(replies[uri.split('/')[1]]);
}
function read() { var out; song.read(function (s) { out = s; }); return out; }

song.init({ luna: luna, now: function () { return now; } });
replies.getActiveMediaSessions = { returnValue: true, activeMediaSessions: [{ mediaId: '_abc', appId: 'spotify-beehive' }] };
replies.getMediaMetaData = { returnValue: true, mediaMetaData: { title: 'Bohemian\nRhapsody', artist: 'Queen', album: 'A Night at the Opera', totalDuration: '354' } };
assert.deepEqual(read(), { title: 'Bohemian Rhapsody', artist: 'Queen', album: 'A Night at the Opera' });
assert.strictEqual(calls[1], 'com.webos.service.mediacontroller/getMediaMetaData {"mediaId":"_abc"}');
now += 3000;
read();
assert.strictEqual(calls.length, 2, 'kept four seconds');
console.log('  ✓ the active session\'s title and artist, kept four seconds');

now += 5000;
replies.getActiveMediaSessions = { returnValue: true, activeMediaSessions: [] };
assert.strictEqual(read(), null, 'no session, no song');
now += 5000;
replies.getActiveMediaSessions = { returnValue: true, activeMediaSessions: ['_x'] };
replies.getMediaMetaData = { returnValue: true, mediaMetaData: { artist: 'Queen' } };
assert.strictEqual(read(), null, 'no title, no song');
console.log('  ✓ nothing where no session plays or it gives no title');

song.init({ luna: luna, now: function () { return now; } });
calls = [];
replies.getActiveMediaSessions = { returnValue: false, errorCode: -1, errorText: 'Service does not exist: com.webos.service.mediacontroller.' };
assert.strictEqual(read(), null);
now += 10000;
assert.strictEqual(read(), null);
assert.strictEqual(calls.length, 1, 'a TV without the service is asked once');
console.log('  ✓ a TV without the service is asked once');

console.log('ALL test-auror-song.js assertions passed!');
