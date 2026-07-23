var canvas = null;
var ctx = null;

self.onmessage = function(event) {
  var msg = event.data;
  if (!msg || msg.type !== 'frame' || (!msg.frame && !msg.bitmap)) return;

  var frame = msg.frame || msg.bitmap;
  var startedAt = performance.now();
  try {
    ensureCanvas(msg.targetW, msg.targetH);
    ctx.imageSmoothingEnabled = false;
    var sourceX = msg.sourceX || 0;
    var sourceY = msg.sourceY || 0;
    var sourceW = msg.sourceW || frame.displayWidth || frame.width;
    var sourceH = msg.sourceH || frame.displayHeight || frame.height;
    ctx.drawImage(frame, sourceX, sourceY, sourceW, sourceH, 0, 0, msg.targetW, msg.targetH);
    frame.close();

    var image = ctx.getImageData(0, 0, msg.targetW, msg.targetH);
    var fingerprint = msg.scan && msg.scan.roi ? fingerprintImage(image) : '';
    var preprocessMs = performance.now() - startedAt;
    self.postMessage({
      type: 'frame',
      image: image,
      scan: msg.scan,
      fingerprint: fingerprint,
      preprocessMs: preprocessMs,
      session: msg.session
    }, [image.data.buffer]);
  } catch (err) {
    try { frame.close(); } catch (_) {}
    self.postMessage({
      type: 'error',
      message: err && err.message ? err.message : String(err),
      frameSeq: msg.scan && msg.scan.frameSeq,
      session: msg.session
    });
  }
};

function ensureCanvas(width, height) {
  if (!canvas || canvas.width !== width || canvas.height !== height) {
    canvas = new OffscreenCanvas(width, height);
    ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) throw new Error('OffscreenCanvas 2D context is unavailable');
  }
}

function fingerprintImage(image) {
  var width = image.width;
  var height = image.height;
  var data = image.data;
  var sampleCols = Math.min(64, width);
  var sampleRows = Math.min(32, height);
  var h1 = 0x811c9dc5;
  var h2 = 0x9e3779b9;
  var sampleIndex = 0;

  for (var sy = 0; sy < sampleRows; sy++) {
    var y = Math.min(height - 1, Math.floor((sy + 0.5) * height / sampleRows));
    for (var sx = 0; sx < sampleCols; sx++, sampleIndex++) {
      var x = Math.min(width - 1, Math.floor((sx + 0.5) * width / sampleCols));
      var offset = (y * width + x) * 4;
      var value = data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16);
      h1 = Math.imul(h1 ^ value, 0x01000193) >>> 0;
      h2 = Math.imul(h2 ^ ((value + sampleIndex) >>> 0), 0x85ebca6b) >>> 0;
    }
  }

  return width + 'x' + height + ':' + h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}
