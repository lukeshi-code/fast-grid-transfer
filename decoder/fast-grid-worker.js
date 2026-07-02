importScripts('../vendor/apriltag3/apriltag_wasm.js', '../vendor/apriltag3/apriltag-wrapper.js');

var TOTAL_CELLS = 100;
var DATA_OFFSET = 18;
var DATA_CELLS = 64;
var HEADER_BYTES = 48;
var FRAME_BYTES_2 = DATA_CELLS * DATA_CELLS * 2 / 8;
var FRAME_BYTES_3 = DATA_CELLS * DATA_CELLS * 3 / 8;
var PROTOCOL_VERSION = 7;
var TAG_BASES = [0, 4];
var TAG_CENTER = {
  tl: [9, 9],
  tr: [91, 9],
  bl: [9, 91],
  br: [91, 91]
};
var PALETTE = [
  [8, 9, 13],
  [248, 251, 255],
  [0, 215, 255],
  [255, 190, 46],
  [255, 159, 10],
  [199, 244, 100],
  [156, 163, 175],
  [51, 65, 85]
];
var detector = null;
var detectorReady = null;
var lastMissReason = 'unknown';
var lastDebugBox = null;
var lastDebug = null;

self.onmessage = async function(event) {
  var msg = event.data;
  if (!msg || msg.type !== 'frame') return;
  try {
    lastMissReason = 'unknown';
    lastDebugBox = null;
    lastDebug = {
      protocol: 'v7',
      geometry: TOTAL_CELLS + 'x' + TOTAL_CELLS + ' / data ' + DATA_CELLS + 'x' + DATA_CELLS,
      image: msg.image ? msg.image.width + 'x' + msg.image.height : '',
      stage: 'start',
      apriltagFound: 0,
      apriltagIds: '',
      missingMarkers: '',
      parse2: '',
      parse3: ''
    };
    var t0 = Date.now();
    var decoded = await decodeImage(msg.image);
    if (lastDebug) lastDebug.workerMs = Date.now() - t0;
    if (decoded && decoded.length) {
      var transfers = decoded.map(function(frame) { return frame.packet; });
      self.postMessage({ type: 'frames', frames: decoded, debug: lastDebug }, transfers);
    }
    else self.postMessage({ type: 'miss', reason: lastMissReason, bbox: lastDebugBox, debug: lastDebug });
  } catch (err) {
    self.postMessage({ type: 'error', message: err.message || String(err) });
  }
};

async function getDetector() {
  if (!detectorReady) {
    detector = new FastGridAprilTag3();
    detectorReady = detector.ready;
  }
  await detectorReady;
  return detector;
}

async function decodeImage(image) {
  if (lastDebug) lastDebug.stage = 'apriltag';
  var groups = await findAprilTagMarkerGroups(image);
  if (!groups.length) return miss('apriltag');
  var frames = [];
  for (var i = 0; i < groups.length; i++) {
    var frame = decodeGrid(image, groups[i].marks, groups[i].slot);
    if (frame) frames.push(frame);
  }
  if (frames.length) return frames;
  return miss('magic');
}

function decodeGrid(image, marks, slot) {
  var data = image.data;
  var w = image.width;
  var h = image.height;

  if (lastDebug) lastDebug.stage = 'homography';
  var homography = buildGridHomography(marks);
  if (!homography) return miss('homography');

  var bbox = markerBounds(marks);
  var dataBox = projectedDataBox(homography);
  var gridBox = projectedGridBox(homography);
  lastDebugBox = { x: gridBox.x, y: gridBox.y, width: gridBox.width, height: gridBox.height, confidence: gridBox.confidence };
  if (lastDebug) {
    lastDebug.bbox = formatBox(gridBox);
    lastDebug.dataBox = formatBox(dataBox);
    lastDebug.gridSlot = slot;
    lastDebug.cellPx = (Math.max(dataBox.width, dataBox.height) / DATA_CELLS).toFixed(2);
  }

  if (lastDebug) lastDebug.stage = 'palette';
  var palette = calibratePalette(data, w, h, homography);
  if (lastDebug) lastDebug.palette = palette.map(function(rgb) {
    return rgb.map(function(v) { return Math.round(v); }).join(',');
  }).join(' | ');
  var frame2 = new Uint8Array(FRAME_BYTES_2);
  var frame3 = new Uint8Array(FRAME_BYTES_3);

  if (lastDebug) lastDebug.stage = 'sample';
  for (var gy = 0; gy < DATA_CELLS; gy++) {
    for (var gx = 0; gx < DATA_CELLS; gx++) {
      var point = project(homography, DATA_OFFSET + gx + 0.5, DATA_OFFSET + gy + 0.5);
      if (!point || point.x < 0 || point.x >= w || point.y < 0 || point.y >= h) return miss('bounds');
      var rgb = sampleRgb(data, w, h, point.x, point.y, bbox.cell * 0.22);
      setBits(frame2, gy * DATA_CELLS + gx, nearestPalette(rgb, palette, 4), 2);
      setBits(frame3, gy * DATA_CELLS + gx, nearestPalette(rgb, palette, 8), 3);
    }
  }

  if (lastDebug) lastDebug.stage = 'parse';
  var parsed2 = parseFrame(frame2, 2, homography);
  var decoded2 = parsed2.frame;
  if (lastDebug) lastDebug.parse2 = parsed2.reason;
  if (decoded2) return decoded2;
  var parsed3 = parseFrame(frame3, 3, homography);
  var decoded3 = parsed3.frame;
  if (lastDebug) lastDebug.parse3 = parsed3.reason;
  if (decoded3) return decoded3;
  return null;
}

async function findAprilTagMarkerGroups(image) {
  var detectorInstance = await getDetector();
  var list = detectorInstance.detect(toGrayscale(image), image.width, image.height) || [];
  var ids = [];
  var groups = [];
  var foundByBase = {};
  for (var b = 0; b < TAG_BASES.length; b++) {
    foundByBase[TAG_BASES[b]] = {};
  }
  for (var i = 0; i < list.length; i++) {
    var marker = list[i];
    ids.push(marker.id);
    for (var baseIndex = 0; baseIndex < TAG_BASES.length; baseIndex++) {
      var base = TAG_BASES[baseIndex];
      if (marker.id === base + 0) foundByBase[base].tl = marker;
      if (marker.id === base + 1) foundByBase[base].tr = marker;
      if (marker.id === base + 2) foundByBase[base].bl = marker;
      if (marker.id === base + 3) foundByBase[base].br = marker;
    }
  }
  var missing = [];
  for (var g = 0; g < TAG_BASES.length; g++) {
    var nextBase = TAG_BASES[g];
    var found = foundByBase[nextBase];
    var missingForGroup = ['tl', 'tr', 'bl', 'br'].filter(function(key) { return !found[key]; });
    if (!missingForGroup.length) {
      groups.push({
        slot: g,
        marks: {
          tl: markerInfo(found.tl),
          tr: markerInfo(found.tr),
          bl: markerInfo(found.bl),
          br: markerInfo(found.br)
        }
      });
    } else {
      missing.push('g' + g + ':' + missingForGroup.join('/'));
    }
  }
  if (lastDebug) {
    lastDebug.apriltagFound = list.length;
    lastDebug.apriltagIds = ids.join(',');
    lastDebug.markerGroups = groups.length;
    lastDebug.missingMarkers = missing.join(' ');
  }
  return groups;
}

function markerInfo(marker) {
  var cx = 0;
  var cy = 0;
  if (marker.center) {
    cx = marker.center.x;
    cy = marker.center.y;
  }
  for (var i = 0; i < marker.corners.length; i++) {
    if (!marker.center) {
      cx += marker.corners[i].x;
      cy += marker.corners[i].y;
    }
  }
  return {
    id: marker.id,
    corners: marker.corners,
    cx: marker.center ? cx : cx / marker.corners.length,
    cy: marker.center ? cy : cy / marker.corners.length
  };
}

function toGrayscale(image) {
  var rgba = image.data;
  var gray = new Uint8Array(image.width * image.height);
  for (var i = 0, j = 0; i < rgba.length; i += 4, j++) {
    gray[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  }
  return gray;
}

function buildGridHomography(marks) {
  var src = [
    TAG_CENTER.tl,
    TAG_CENTER.tr,
    TAG_CENTER.br,
    TAG_CENTER.bl
  ];
  var dst = [
    [marks.tl.cx, marks.tl.cy],
    [marks.tr.cx, marks.tr.cy],
    [marks.br.cx, marks.br.cy],
    [marks.bl.cx, marks.bl.cy]
  ];
  return solveHomography(src, dst);
}

function markerBounds(marks) {
  var minX = Infinity;
  var minY = Infinity;
  var maxX = -Infinity;
  var maxY = -Infinity;
  var centers = [marks.tl, marks.tr, marks.bl, marks.br];
  for (var i = 0; i < centers.length; i++) {
    for (var j = 0; j < centers[i].corners.length; j++) {
      var c = centers[i].corners[j];
      minX = Math.min(minX, c.x);
      minY = Math.min(minY, c.y);
      maxX = Math.max(maxX, c.x);
      maxY = Math.max(maxY, c.y);
    }
  }
  var cell = Math.max(2, Math.max(maxX - minX, maxY - minY) / TOTAL_CELLS);
  return { minX: minX, minY: minY, maxX: maxX, maxY: maxY, cell: cell };
}

function projectedDataBox(h) {
  return projectedBox(h, DATA_OFFSET, DATA_OFFSET, DATA_CELLS, DATA_CELLS, 0.9);
}

function projectedGridBox(h) {
  return projectedBox(h, 0, 0, TOTAL_CELLS, TOTAL_CELLS, 0.92);
}

function projectedBox(h, x, y, width, height, confidence) {
  var pts = [
    project(h, x, y),
    project(h, x + width, y),
    project(h, x + width, y + height),
    project(h, x, y + height)
  ];
  var minX = Math.min(pts[0].x, pts[1].x, pts[2].x, pts[3].x);
  var maxX = Math.max(pts[0].x, pts[1].x, pts[2].x, pts[3].x);
  var minY = Math.min(pts[0].y, pts[1].y, pts[2].y, pts[3].y);
  var maxY = Math.max(pts[0].y, pts[1].y, pts[2].y, pts[3].y);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY, confidence: confidence };
}

function calibratePalette(data, w, h, homography) {
  var sums = PALETTE.map(function() { return [0, 0, 0, 0]; });
  var rows = [3.5, TOTAL_CELLS - 3.5];
  for (var r = 0; r < rows.length; r++) {
    for (var i = 0; i < DATA_CELLS; i++) {
      var colorIndex = i % 8;
      var p = project(homography, DATA_OFFSET + i + 0.5, rows[r]);
      if (!p) continue;
      var rgb = sampleRgb(data, w, h, p.x, p.y, 1.2);
      sums[colorIndex][0] += rgb[0];
      sums[colorIndex][1] += rgb[1];
      sums[colorIndex][2] += rgb[2];
      sums[colorIndex][3]++;
    }
  }
  return sums.map(function(sum, i) {
    if (!sum[3]) return PALETTE[i].slice();
    return [sum[0] / sum[3], sum[1] / sum[3], sum[2] / sum[3]];
  });
}

function parseFrame(frame, bits, homography) {
  if (frame[0] !== 70 || frame[1] !== 71 || frame[2] !== 70 || frame[3] !== 50) return { frame: null, reason: 'magic' };
  if (frame[4] !== PROTOCOL_VERSION || frame[5] !== bits) return { frame: null, reason: 'version ' + frame[4] + '/' + frame[5] };
  var sourceSymbols = readU32(frame, 12);
  var transferLength = readU32(frame, 16);
  var packetLen = readU16(frame, 20);
  var checksum = readU32(frame, 22);
  var payloadBytes = readU16(frame, 26);
  var mtu = readU16(frame, 28);
  var repairPacketsPerBlock = readU16(frame, 30);
  var cycleSymbols = readU32(frame, 32);
  var dataCells = readU16(frame, 36);
  var headerBytes = readU16(frame, 38);
  var symbolIndex = readU32(frame, 8);
  var packetIndex = readU32(frame, 40);
  var expectedPayload = (bits === 3 ? FRAME_BYTES_3 : FRAME_BYTES_2) - HEADER_BYTES;
  if (lastDebug) {
    lastDebug.parsedBits = bits;
    lastDebug.parsedSourceSymbols = sourceSymbols;
    lastDebug.parsedSymbolIndex = symbolIndex;
    lastDebug.parsedPacketIndex = packetIndex;
    lastDebug.parsedPacketLen = packetLen;
  }
  if (sourceSymbols < 1 || transferLength < 1 || packetLen < 5 || packetLen > expectedPayload) return { frame: null, reason: 'header packet=' + packetLen + ' src=' + sourceSymbols + ' len=' + transferLength };
  if (payloadBytes !== expectedPayload || mtu + 4 > payloadBytes) return { frame: null, reason: 'payload payload=' + payloadBytes + ' mtu=' + mtu + ' expected=' + expectedPayload };
  if (dataCells !== DATA_CELLS || headerBytes !== HEADER_BYTES) return { frame: null, reason: 'geometry data=' + dataCells + ' header=' + headerBytes };
  var packet = frame.slice(HEADER_BYTES, HEADER_BYTES + packetLen);
  var actualChecksum = checksum32(packet);
  if (actualChecksum !== checksum) return { frame: null, reason: 'checksum want=' + checksum + ' got=' + actualChecksum };
  var gridBox = projectedGridBox(homography);
  var dataBox = projectedDataBox(homography);
  return { frame: {
    kind: 'raptorq',
    symbolIndex: symbolIndex,
    sourceSymbols: sourceSymbols,
    transferLength: transferLength,
    packetLen: packetLen,
    payloadBytes: payloadBytes,
    mtu: mtu,
    repairPacketsPerBlock: repairPacketsPerBlock,
    cycleSymbols: cycleSymbols,
    packetIndex: packetIndex,
    colorBits: bits,
    gridSlot: lastDebug ? lastDebug.gridSlot : 0,
    bbox: gridBox,
    dataBox: dataBox,
    packet: packet.buffer
  }, reason: 'ok' };
}

function sampleRgb(data, w, h, x, y, radius) {
  var r = Math.max(1, Math.floor(radius || 1));
  var sumR = 0;
  var sumG = 0;
  var sumB = 0;
  var count = 0;
  var cx = Math.round(x);
  var cy = Math.round(y);
  for (var yy = cy - r; yy <= cy + r; yy++) {
    if (yy < 0 || yy >= h) continue;
    for (var xx = cx - r; xx <= cx + r; xx++) {
      if (xx < 0 || xx >= w) continue;
      var p = (yy * w + xx) * 4;
      sumR += data[p];
      sumG += data[p + 1];
      sumB += data[p + 2];
      count++;
    }
  }
  if (!count) return [0, 0, 0];
  return [sumR / count, sumG / count, sumB / count];
}

function nearestPalette(rgb, palette, count) {
  var best = 0;
  var bestDist = Infinity;
  for (var i = 0; i < count; i++) {
    var dr = rgb[0] - palette[i][0];
    var dg = rgb[1] - palette[i][1];
    var db = rgb[2] - palette[i][2];
    var dist = dr * dr + dg * dg + db * db;
    if (dist < bestDist) {
      bestDist = dist;
      best = i;
    }
  }
  return best;
}

function setBits(bytes, index, value, bits) {
  var bit = index * bits;
  var byteIndex = bit >> 3;
  var shift = bit & 7;
  bytes[byteIndex] |= (value & ((1 << bits) - 1)) << shift;
  if (shift + bits > 8 && byteIndex + 1 < bytes.length) {
    bytes[byteIndex + 1] |= (value & ((1 << bits) - 1)) >> (8 - shift);
  }
}

function solveHomography(src, dst) {
  var a = [];
  var b = [];
  for (var i = 0; i < 4; i++) {
    var x = src[i][0];
    var y = src[i][1];
    var X = dst[i][0];
    var Y = dst[i][1];
    a.push([x, y, 1, 0, 0, 0, -X * x, -X * y]);
    b.push(X);
    a.push([0, 0, 0, x, y, 1, -Y * x, -Y * y]);
    b.push(Y);
  }
  var h = solveLinearSystem(a, b);
  if (!h) return null;
  h.push(1);
  return h;
}

function solveLinearSystem(a, b) {
  var n = b.length;
  for (var i = 0; i < n; i++) {
    a[i] = a[i].slice();
    a[i].push(b[i]);
  }
  for (var col = 0; col < n; col++) {
    var pivot = col;
    for (var row = col + 1; row < n; row++) {
      if (Math.abs(a[row][col]) > Math.abs(a[pivot][col])) pivot = row;
    }
    if (Math.abs(a[pivot][col]) < 1e-9) return null;
    var tmp = a[col];
    a[col] = a[pivot];
    a[pivot] = tmp;
    var div = a[col][col];
    for (var k = col; k <= n; k++) a[col][k] /= div;
    for (var r = 0; r < n; r++) {
      if (r === col) continue;
      var factor = a[r][col];
      for (var c = col; c <= n; c++) a[r][c] -= factor * a[col][c];
    }
  }
  var out = [];
  for (var i2 = 0; i2 < n; i2++) out.push(a[i2][n]);
  return out;
}

function project(h, x, y) {
  var d = h[6] * x + h[7] * y + h[8];
  if (Math.abs(d) < 1e-9) return null;
  return {
    x: (h[0] * x + h[1] * y + h[2]) / d,
    y: (h[3] * x + h[4] * y + h[5]) / d
  };
}

function miss(reason) {
  lastMissReason = reason;
  if (lastDebug) lastDebug.stage = reason;
  return null;
}

function formatBox(box) {
  return [
    Math.round(box.x),
    Math.round(box.y),
    Math.round(box.width),
    Math.round(box.height)
  ].join(',');
}

function readU16(buf, offset) {
  return buf[offset] | (buf[offset + 1] << 8);
}

function readU32(buf, offset) {
  return (buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24)) >>> 0;
}

function checksum32(bytes) {
  var h = 2166136261 >>> 0;
  for (var i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
