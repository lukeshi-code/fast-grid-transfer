var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');

var root = path.resolve(__dirname, '..');

function read(file) {
  return fs.readFileSync(path.join(root, file), 'utf8');
}

function parseInlineScripts(file) {
  var html = read(file);
  var scripts = Array.from(html.matchAll(/<script>([\s\S]*?)<\/script>/g)).map(function(m) { return m[1]; });
  scripts.forEach(function(script) { new Function(script); });
  return scripts.length;
}

test('fast grid pages parse', function() {
  assert.equal(parseInlineScripts('index.html'), 0);
  assert.equal(parseInlineScripts('encoder/index.html'), 1);
  assert.equal(parseInlineScripts('decoder/index.html'), 1);
  new Function(read('encoder/fast-grid-encoder-worker.js'));
  new Function(read('decoder/fast-grid-worker.js'));
});

test('main pages use fast grid, not the old QR pipeline', function() {
  var combined = [
    read('index.html'),
    read('encoder/index.html'),
    read('decoder/index.html'),
    read('decoder/fast-grid-worker.js')
  ].join('\n');
  assert.match(combined, /Fast Grid/);
  assert.doesNotMatch(combined, /jsQR|qrcode|ReedSolomon|BarcodeDetector/);
});

test('old QR assets are removed from active directories', function() {
  [
    'encoder/qrcode.js',
    'encoder/reedsolomon.js',
    'decoder/jsQR.min.js',
    'decoder/reedsolomon.js',
    'shared/reedsolomon.js'
  ].forEach(function(file) {
    assert.equal(fs.existsSync(path.join(root, file)), false, file);
  });
});
