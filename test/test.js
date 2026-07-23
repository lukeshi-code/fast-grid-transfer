var test = require('node:test');
var assert = require('node:assert/strict');
var fs = require('node:fs');
var path = require('node:path');
var vm = require('node:vm');

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
  new Function(read('decoder/frame-preprocess-worker.js'));
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

test('capture preprocessor returns transferable image data', function() {
  var posted = null;
  var bitmapClosed = false;
  var drawArgs = null;
  var fakeContext = {
    imageSmoothingEnabled: true,
    drawImage: function() { drawArgs = Array.from(arguments); },
    getImageData: function() {
      return { width: 4, height: 2, data: new Uint8ClampedArray(4 * 2 * 4) };
    }
  };
  var context = {
    self: {
      postMessage: function(message, transfers) {
        posted = { message: message, transfers: transfers };
      }
    },
    performance: { now: function() { return 1; } },
    OffscreenCanvas: function(width, height) {
      this.width = width;
      this.height = height;
      this.getContext = function() { return fakeContext; };
    }
  };
  vm.runInNewContext(read('decoder/frame-preprocess-worker.js'), context);
  context.self.onmessage({
    data: {
      type: 'frame',
      frame: {
        displayWidth: 8,
        displayHeight: 6,
        close: function() { bitmapClosed = true; }
      },
      sourceX: 1,
      sourceY: 2,
      sourceW: 6,
      sourceH: 4,
      targetW: 4,
      targetH: 2,
      scan: { frameSeq: 3, roi: true },
      session: 7
    }
  });

  assert.equal(bitmapClosed, true);
  assert.equal(posted.message.type, 'frame');
  assert.equal(posted.message.session, 7);
  assert.match(posted.message.fingerprint, /^4x2:/);
  assert.equal(posted.transfers[0], posted.message.image.data.buffer);
  assert.deepEqual(drawArgs.slice(1), [1, 2, 6, 4, 0, 0, 4, 2]);
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
  assert.match(encoder, /playbackAccumulator\s*=\s*Math\.min\(playbackAccumulator\s*\+\s*elapsed,\s*interval\s*\*\s*2\)/);
  assert.match(encoder, /playbackAccumulator\s*>=\s*interval\s*&&\s*tickPlayback\(\)/);
  assert.match(encoder, /playbackAccumulator\s*-=\s*interval/);
  assert.doesNotMatch(encoder, /timestamp\s*-\s*lastPlaybackAt\s*>\s*interval/);
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
  assert.match(decoder, /new MediaStreamTrackProcessor\(\{\s*track:\s*track,\s*maxBufferSize:\s*1\s*\}\)/);
  assert.match(decoder, /trackProcessor\.readable\.getReader\(\)/);
  assert.match(decoder, /queueCaptureFrame\(\{\s*frame:\s*frame,/);
  assert.match(decoder, /capturePath\s*=\s*'TrackProcessor \+ VideoFrame'/);
  assert.match(decoder, /if\s*\(!stream\s*\|\|\s*decodedBlob\s*\|\|\s*trackPumpActive\s*\|\|\s*scanScheduled\)\s*return/);
  assert.match(decoder, /createImageBitmap\(video,/);
  assert.match(decoder, /new Worker\('frame-preprocess-worker\.js'\)/);
  assert.match(decoder, /applyConstraints\(\{\s*frameRate:\s*\{\s*ideal:\s*60,\s*max:\s*60\s*\}\s*\}\)/);
  assert.match(decoder, /\['Video delivery fps',\s*lastDeliveredFps\]/);
  assert.match(decoder, /\['Capture ready fps',\s*lastCaptureFps\]/);
  assert.match(read('decoder/frame-preprocess-worker.js'), /new OffscreenCanvas\(width,\s*height\)/);
  assert.match(read('decoder/frame-preprocess-worker.js'), /ctx\.getImageData\(/);
  assert.match(decoder, /RECENT_VISUAL_LIMIT\s*=\s*512/);
  assert.match(decoder, /VERIFIED_FINGERPRINT_LIMIT\s*=\s*128/);
  assert.match(decoder, /fingerprintImage\(image\)/);
  assert.match(decoder, /resolveFingerprintScan\(scan,\s*roiSlots\.length\s*>=\s*EXPECTED_GRIDS\)/);
  assert.match(decoder, /recordGridSlotResult\(roiSlots\)/);
  assert.match(decoder, /\['Top grid',\s*formatGridSlotStats\(0\)\]/);
  assert.match(decoder, /\['Bottom grid',\s*formatGridSlotStats\(1\)\]/);
  assert.match(decoder, /\['Weaker slot',\s*weakerGridSlot\(\)\]/);
});
