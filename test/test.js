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

test('large-file incremental SHA-256 matches the standard digest across chunk boundaries', function() {
  var protocolContext = {};
  vm.runInNewContext(read('shared/protocol.js'), protocolContext);
  var workerContext = {
    self: { FastGridProtocol: protocolContext.FastGridProtocol },
    importScripts: function() {},
    TextEncoder: TextEncoder,
    Uint8Array: Uint8Array,
    Uint32Array: Uint32Array,
    Map: Map,
    Math: Math,
    performance: { now: function() { return 0; } }
  };
  vm.runInNewContext(read('encoder/fast-grid-encoder-worker.js'), workerContext);
  var hasher = new workerContext.Sha256();
  hasher.update(new TextEncoder().encode('The quick brown '));
  hasher.update(new TextEncoder().encode('fox jumps over the lazy dog'));
  assert.equal(
    Buffer.from(hasher.digest()).toString('hex'),
    'd7a8fbb307d7809469ca9abcb0082e4f8d5651e46d3cdb762d02d0bf37c9e592'
  );
});

test('on-demand stream blocks preserve the header and source byte offsets', async function() {
  var protocolContext = {};
  vm.runInNewContext(read('shared/protocol.js'), protocolContext);
  var workerContext = {
    self: { FastGridProtocol: protocolContext.FastGridProtocol },
    importScripts: function() {},
    TextEncoder: TextEncoder,
    Uint8Array: Uint8Array,
    Uint32Array: Uint32Array,
    Map: Map,
    Math: Math,
    performance: { now: function() { return 0; } }
  };
  vm.runInNewContext(read('encoder/fast-grid-encoder-worker.js'), workerContext);
  var source = new Uint8Array([10, 11, 12, 13, 14, 15]);
  workerContext.streamBytes = null;
  workerContext.streamHeader = new Uint8Array([1, 2, 3, 4]);
  workerContext.payloadSegments = [{
    type: 'file', offset: 0, length: source.length,
    file: { slice: function(start, end) { return { arrayBuffer: async function() { return source.slice(start, end).buffer; } }; } }
  }];
  assert.deepEqual(Array.from(await workerContext.readStreamRange(0, 7)), [1, 2, 3, 4, 10, 11, 12]);
  assert.deepEqual(Array.from(await workerContext.readStreamRange(5, 4)), [11, 12, 13, 14]);
});

test('protocol geometry and synchronized frame rates stay aligned', function() {
  var protocol = read('shared/protocol.js');
  var protocolContext = {};
  vm.runInNewContext(protocol, protocolContext);
  var protocolValues = protocolContext.FastGridProtocol;
  var encoder = read('encoder/index.html');
  var decoder = read('decoder/index.html');
  var encoderWorker = read('encoder/fast-grid-encoder-worker.js');
  var decodeWorker = read('decoder/fast-grid-worker.js');

  assert.equal(protocolValues.totalCols, 360);
  assert.equal(protocolValues.totalRows, 112);
  assert.equal(protocolValues.dataCols, 324);
  assert.equal(protocolValues.dataRows, 108);
  assert.equal(protocolValues.protocolVersion, 14);
  assert.equal(protocolValues.frameBytes2 - protocolValues.headerBytes, 8692);
  assert.equal(protocolValues.frameBytes3 - protocolValues.headerBytes, 13066);
  assert.deepEqual(Array.from(protocolValues.calibrationRows), [3, 108]);
  assert.deepEqual(Array.from(protocolValues.syncRows), [17, 94]);
  assert.equal(new Set(protocolValues.dataPhysicalRows).size, 108);
  [3, 17, 94, 108].forEach(function(row) {
    assert.equal(protocolValues.dataPhysicalRows.includes(row), false);
  });
  assert.match(encoder, /window\.FastGridProtocol\s*\|\|\s*createProtocolFallback\(\)/);
  assert.match(encoder, /folderInput\.value\s*=\s*''/);
  assert.match(encoder, /restartEncoderWorker\(\)/);
  assert.match(encoder, /msg\.type\s*===\s*'prepare-progress'/);
  assert.match(encoderWorker, /RAPTOR_CHUNK_BYTES\s*=\s*16\s*\*\s*1024\s*\*\s*1024/);
  assert.match(encoderWorker, /LARGE_FILE_STREAM_THRESHOLD\s*=\s*32\s*\*\s*1024\s*\*\s*1024/);
  assert.match(encoderWorker, /function hashPayloadIncrementally\(/);
  assert.match(encoderWorker, /function readStreamRange\(/);
  assert.match(encoderWorker, /new Blob\(parts\)\.arrayBuffer\(\)/);
  assert.match(encoderWorker, /function buildRaptorBlocks\(/);
  assert.match(encoderWorker, /frame\[6\]\s*=\s*block\.index/);
  assert.match(decoder, /raptorDecoders\s*=\s*Object\.create\(null\)/);
  assert.match(decoder, /decodedChunks\[frame\.blockIndex\]/);
  assert.match(decodeWorker, /var blockIndex = frame\[6\]/);
  assert.match(encoder, /var physicalY = DATA_PHYSICAL_ROWS\[y\]/);
  assert.match(decodeWorker, /var physicalY = DATA_PHYSICAL_ROWS\[gy\]/);
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
  assert.match(decoder, /MIN_SCAN_WIDTH\s*=\s*1280/);
  assert.match(decoder, /function getScanSize\(source\)/);
  assert.match(decoder, /requestVideoFrameCallback\(scanFrame\)/);
  assert.match(decoder, /new MediaStreamTrackProcessor\(\{\s*track:\s*track,\s*maxBufferSize:\s*1\s*\}\)/);
  assert.match(decoder, /trackProcessor\.readable\.getReader\(\)/);
  assert.match(decoder, /queueCaptureFrame\(\{\s*frame:\s*frame,/);
  assert.match(decoder, /capturePath\s*=\s*'TrackProcessor \+ VideoFrame'/);
  assert.match(decoder, /if\s*\(!stream\s*\|\|\s*decodedBlob\s*\|\|\s*trackPumpActive\s*\|\|\s*scanScheduled\)\s*return/);
  assert.match(decoder, /createImageBitmap\(video,/);
  assert.match(decoder, /new Worker\('frame-preprocess-worker\.js'\)/);
  assert.match(decoder, /width:\s*\{\s*ideal:\s*1920,\s*max:\s*1920\s*\}/);
  assert.match(decoder, /height:\s*\{\s*ideal:\s*1080,\s*max:\s*1080\s*\}/);
  assert.match(decoder, /applyConstraints\(\{\s*frameRate:\s*\{\s*ideal:\s*60,\s*max:\s*60\s*\}\s*\}\)/);
  assert.match(decoder, /setDirectTrackPreview\(true\)/);
  assert.match(decoder, /High-resolution preview is disabled/);
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
