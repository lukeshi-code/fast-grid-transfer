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
  assert.equal(parseInlineScripts('delta/index.html'), 1);
  new Function(read('encoder/fast-grid-encoder-worker.js'));
  new Function(read('decoder/fast-grid-worker.js'));
});

test('main pages use fast grid, not the old QR pipeline', function() {
  var combined = [
    read('index.html'),
    read('encoder/index.html'),
    read('decoder/index.html'),
    read('delta/index.html'),
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

test('protocol geometry and synchronized frame rates stay aligned', function() {
  var protocol = read('shared/protocol.js');
  var encoder = read('encoder/index.html');
  var decoder = read('decoder/index.html');

  assert.match(protocol, /totalCols:\s*360/);
  assert.match(protocol, /totalRows:\s*112/);
  assert.match(protocol, /dataCols:\s*324/);
  assert.match(protocol, /dataRows:\s*76/);
  assert.match(protocol, /protocolVersion:\s*12/);
  assert.match(encoder, /id="fps"[^>]*max="30"[^>]*value="30"/);
  assert.match(encoder, /requestAnimationFrame\(playbackLoop\)/);
  assert.match(encoder, /createImageData\(TOTAL_COLS,\s*TOTAL_ROWS\)/);
  assert.match(encoder, /logicalCtx\.putImageData\(logicalImage,\s*0,\s*0\)/);
  assert.match(encoder, /pixels\.set\(logicalBasePixels\)/);
  assert.match(encoder, /ctx\.drawImage\(logicalCanvas,/);
  assert.match(encoder, /nextCanvas\.width\s*=\s*TOTAL_COLS/);
  assert.doesNotMatch(encoder, /nextCanvas\.width\s*=\s*optimalW/);
  assert.match(encoder, /RAF ['"]?\s*\+/);
  assert.match(encoder, /recordRenderDuration\(/);
  assert.match(encoder, /Worker waits/);
  assert.match(encoder, /countReadyGrids\(\)/);
  assert.match(encoder, /encodedGridCount\+\+/);
  assert.match(encoder, /playbackFrameCount\+\+/);
  assert.match(encoder, /Encode ['"]?\s*\+/);
  assert.doesNotMatch(decoder, /\['Capture cap'/);
  assert.match(decoder, /CAPTURE_FPS_LIMIT\s*=\s*60/);
  assert.match(decoder, /requestVideoFrameCallback\(scanFrame\)/);
  assert.match(decoder, /RECENT_VISUAL_LIMIT\s*=\s*512/);
  assert.match(decoder, /VERIFIED_FINGERPRINT_LIMIT\s*=\s*128/);
  assert.match(decoder, /fingerprintImage\(image\)/);
  assert.match(decoder, /resolveFingerprintScan\(scan,\s*roiSlots\.length\s*>=\s*EXPECTED_GRIDS\)/);
  assert.match(decoder, /recordGridSlotResult\(roiSlots\)/);
  assert.match(decoder, /\['Top grid',\s*formatGridSlotStats\(0\)\]/);
  assert.match(decoder, /\['Bottom grid',\s*formatGridSlotStats\(1\)\]/);
  assert.match(decoder, /\['Weaker slot',\s*weakerGridSlot\(\)\]/);
});
