// Run with: node test/discover.test.js
'use strict';

var assert = require('assert');
var fs = require('fs');
var path = require('path');
var D = require('../app/js/discover.js');

var tests = [];
function test(name, fn) { tests.push([name, fn]); }

test('finds player and chat in the saved site snapshot', function () {
  var html = fs.readFileSync(path.join(__dirname, 'fixtures/cathodetv-2026-10-25.html'), 'utf8');
  var r = D.parse(html);
  assert.strictEqual(r.player, 'https://ok.ru/videoembed/15845833842384?nochat=1');
  assert.strictEqual(r.chat, 'https://minnit.chat/CATHODETV?embed&dark&nickname=');
});

test('normalizes malformed and protocol-relative URLs', function () {
  assert.strictEqual(D.normalizeUrl('https:////ok.ru/x'), 'https://ok.ru/x');
  assert.strictEqual(D.normalizeUrl('//player.example/x'), 'https://player.example/x');
  assert.strictEqual(D.normalizeUrl('  http://a.example/?a=1&amp;b=2 '), 'http://a.example/?a=1&b=2');
  assert.strictEqual(D.normalizeUrl('/relative/path'), null);
  assert.strictEqual(D.normalizeUrl(''), null);
});

test('picks a new host when the player iframe changes', function () {
  var r = D.parse(
    "<iframe src='https://minnit.chat/CATHODETV?embed'></iframe>" +
    '<iframe class="x" src="https://newhost.example/embed/abc"></iframe>');
  assert.strictEqual(r.player, 'https://newhost.example/embed/abc');
  assert.strictEqual(r.chat, 'https://minnit.chat/CATHODETV?embed');
});

test('ignores site-builder and link iframes', function () {
  var r = D.parse('<iframe src="https://framer.com/edit"></iframe><iframe src="https://p.example/e"></iframe>');
  assert.strictEqual(r.player, 'https://p.example/e');
  assert.deepStrictEqual(r.frames, ['https://p.example/e']);
});

test('falls back to a bare HLS URL when there is no player iframe', function () {
  var r = D.parse('<script>var src = "https://cdn.example/live/index.m3u8?token=1";</script>');
  assert.strictEqual(r.player, 'https://cdn.example/live/index.m3u8?token=1');
  assert.strictEqual(r.stream, r.player);
});

test('returns nulls for pages without embeds', function () {
  var r = D.parse('<html><body>offline</body></html>');
  assert.strictEqual(r.player, null);
  assert.strictEqual(r.chat, null);
});

test('detects direct media URLs', function () {
  assert.ok(D.isDirectMedia('https://x/live.m3u8'));
  assert.ok(D.isDirectMedia('https://x/movie.mp4?t=1'));
  assert.ok(!D.isDirectMedia('https://ok.ru/videoembed/1'));
});

var failed = 0;
tests.forEach(function (t) {
  try { t[1](); console.log('ok   ' + t[0]); }
  catch (e) { failed++; console.log('FAIL ' + t[0] + '\n     ' + e.message); }
});
console.log('\n' + (tests.length - failed) + '/' + tests.length + ' passed');
process.exit(failed ? 1 : 0);
