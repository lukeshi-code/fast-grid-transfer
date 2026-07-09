importScripts('../shared/protocol.js', '../vendor/apriltag3/apriltag_wasm.js', '../vendor/apriltag3/apriltag-wrapper.js');

var P = self.FastGridProtocol;
var TOTAL_COLS = P.totalCols;
var TOTAL_ROWS = P.totalRows;
var DATA_OFFSET_X = P.dataOffsetX;
var DATA_OFFSET_Y = P.dataOffsetY;
var DATA_COLS = P.dataCols;
var DATA_ROWS = P.dataRows;
var DATA_CELLS = DATA_COLS * DATA_ROWS;
var HEADER_BYTES = P.headerBytes;
var FRAME_BYTES_2 = P.frameBytes2;
var FRAME_BYTES_3 = P.frameBytes3;
var PROTOCOL_VERSION = P.protocolVersion;
var TAG_BASES = P.tagBases.slice();
var CACHE_MAX_AGE = P.cacheMaxAge;
var EXPECTED_GRIDS = P.expectedGrids;

var TAG_CENTER = {
  tl: [9, 9],
  tr: [TOTAL_COLS - 9, 9],
  bl: [9, TOTAL_ROWS - 9],
  br: [TOTAL_COLS - 9, TOTAL_ROWS - 9]
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
var homographyCache = {};
var workerFrameSeq = 0;

var grayScratch = null;
var grayScratchWidth = 0;
var grayScratchHeight = 0;
var sampleKeyScratch = new Uint16Array(DATA_CELLS);
var frame2Scratch = new Uint8Array(FRAME_BYTES_2);
var frame3Scratch = new Uint8Array(FRAME_BYTES_3);
var lutCache = {
  4: { key: '', lut: null },
  8: { key: '', lut: null }
};

self.onmessage = async function(event) {
  var msg = event.data;
  if (!msg || msg.type !== 'frame') return;
  try {
    workerFrameSeq = msg.frameSeq || (workerFrameSeq + 1);
    lastMissReason = 'unknown';
    lastDebugBox = null;
    lastDebug = {
      protocol: 'v' + PROTOCOL_VERSION,
      geometry: TOTAL_COLS + 'x' + TOTAL_ROWS + ' / data ' + DATA_COLS + 'x' + DATA_ROWS,
      image: msg.image ? msg.image.width + 'x' + msg.image.height : '',
      stage: 'start',
      apriltagFound: 0,
      apriltagIds: '',
      missingMarkers: '',
      markerGroups: 0,
      parse2: '',
      parse3: '',
      cache: '',
      fastPath: ''
    };
    var t0 = performance.now();
    var decoded = await decodeImage(msg.image, msg.relocate === true);
    if (lastDebug) lastDebug.workerMs = +(performance.now() - t0).toFixed(2);
    if (decoded && decoded.length) {
      var transfers = decoded.map(function(frame) { return frame.packet; });
      self.postMessage({ type: 'frames', frames: decoded, debug: lastDebug, frameSeq: workerFrameSeq }, transfers);
    } else {
      self.postMessage({ type: 'miss', reason: lastMissReason, bbox: lastDebugBox, debug: lastDebug, frameSeq: workerFrameSeq });
    }
  } catch (err) {
    self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err), frameSeq: workerFrameSeq });
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

async function decodeImage(image, relocate) {
  if (!relocate) {
    var cachedFrames = tryDecodeAllCached(image);
    if (cachedFrames && cachedFrames.length === EXPECTED_GRIDS) {
      if (lastDebug) lastDebug.cache = 'all-hit';
      return cachedFrames;
    }
    if (lastDebug) lastDebug.cache = cachedFrames && cachedFrames.length ? 'partial-fallback' : 'miss';
  }

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

function tryDecodeAllCached(image) {
  var frames = [];
  for (var slot = 0; slot < EXPECTED_GRIDS; slot++) {
    var cached = homographyCache[slot];
    if (!cached || workerFrameSeq - cached.frameSeq > CACHE_MAX_AGE) return null;
    var frame = decodeGridFromHomography(image, cached.homography, slot, null, true, cached);
    if (!frame) return frames;
    frames.push(frame);
  }
  return frames;
}

function decodeGrid(image, marks, slot) {
  if (lastDebug) lastDebug.stage = 'homography';
  var homography = buildGridHomography(marks);
  if (!homography) return miss('homography');
  return decodeGridFromHomography(image, homography, slot, marks, false, null);
}

function decodeGridFromHomography(image, homography, slot, marks, fromCache, cacheEntry) {
  var data = image.data;
  var w = image.width;
  var h = image.height;
  var dataBox = projectedDataBox(homography);
  var gridBox = projectedGridBox(homography);
  lastDebugBox = { x: gridBox.x, y: gridBox.y, width: gridBox.width, height: gridBox.height, confidence: gridBox.confidence };

  if (lastDebug) {
    lastDebug.bbox = formatBox(gridBox);
    lastDebug.dataBox = formatBox(dataBox);
    lastDebug.gridSlot = slot;
    lastDebug.cellPx = Math.max(dataBox.width / DATA_COLS, dataBox.height / DATA_ROWS).toFixed(2);
  }

  var sampleMap = cacheEntry && cacheEntry.sampleMap;
  if (!sampleMap) {
    sampleMap = buildSampleMap(homography);
    if (!sampleMap) return miss('homography-map');
  }

  if (lastDebug) lastDebug.stage = 'palette';
  var palette = calibratePalette(data, w, h, homography);
  if (lastDebug) {
    lastDebug.palette = palette.map(function(rgb) {
      return rgb.map(function(v) { return Math.round(v); }).join(',');
    }).join(' | ');
  }

  var sampleRadius = Math.max(1, Math.max(dataBox.width / DATA_COLS, dataBox.height / DATA_ROWS) * 0.22);
  if (lastDebug) lastDebug.stage = 'sample';
  if (!sampleCellsToKeys(data, w, h, sampleMap, sampleRadius)) {
    if (fromCache) delete homographyCache[slot];
    return miss('bounds');
  }

  var preferredBits = cacheEntry && cacheEntry.modeBits;
  var decoded = null;
  if (preferredBits === 2 || preferredBits === 3) {
    if (lastDebug) lastDebug.fastPath = preferredBits + '-bit';
    decoded = decodeSampleKeys(palette, preferredBits, homography);
    if (decoded) {
      saveCache(slot, homography, sampleMap, preferredBits);
      return decoded;
    }
    if (lastDebug) lastDebug.fastPath += ' fallback';
    decoded = decodeSampleKeys(palette, preferredBits === 2 ? 3 : 2, homography);
    if (decoded) {
      saveCache(slot, homography, sampleMap, decoded.colorBits);
      return decoded;
    }
  } else {
    decoded = decodeSampleKeys(palette, 2, homography);
    if (!decoded) decoded = decodeSampleKeys(palette, 3, homography);
    if (decoded) {
      saveCache(slot, homography, sampleMap, decoded.colorBits);
      return decoded;
    }
  }

  if (fromCache) delete homographyCache[slot];
  return null;
}

function saveCache(slot, homography, sampleMap, modeBits) {
  homographyCache[slot] = {
    homography: homography.slice(),
    sampleMap: sampleMap,
    frameSeq: workerFrameSeq,
    modeBits: modeBits
  };
}

function buildSampleMap(h) {
  var xy = new Float64Array(DATA_CELLS * 2);
  var index = 0;
  for (var gy = 0; gy < DATA_ROWS; gy++) {
    for (var gx = 0; gx < DATA_COLS; gx++, index++) {
      var p = project(h, DATA_OFFSET_X + gx + 0.5, DATA_OFFSET_Y + gy + 0.5);
      if (!p) return null;
      xy[index * 2] = p.x;
      xy[index * 2 + 1] = p.y;
    }
  }
  return xy;
}

function sampleCellsToKeys(data, w, h, sampleMap, radius) {
  for (var i = 0; i < DATA_CELLS; i++) {
    var x = sampleMap[i * 2];
    var y = sampleMap[i * 2 + 1];
    if (x < 0 || x >= w || y < 0 || y >= h) return false;
    var rgb = sampleRgb(data, w, h, x, y, radius);
    var r = Math.max(0, Math.min(31, rgb[0] >> 3));
    var g = Math.max(0, Math.min(31, rgb[1] >> 3));
    var b = Math.max(0, Math.min(31, rgb[2] >> 3));
    sampleKeyScratch[i] = (r << 10) | (g << 5) | b;
  }
  return true;
}

function decodeSampleKeys(palette, bits, homography) {
  var frame = bits === 3 ? frame3Scratch : frame2Scratch;
  frame.fill(0);
  var count = bits === 3 ? 8 : 4;
  var lut = getPaletteLut(palette, count);
  for (var i = 0; i < DATA_CELLS; i++) setBits(frame, i, lut[sampleKeyScratch[i]], bits);

  if (lastDebug) lastDebug.stage = 'parse';
  var parsed = parseFrame(frame, bits, homography);
  if (lastDebug) {
    if (bits === 2) lastDebug.parse2 = parsed.reason;
    else lastDebug.parse3 = parsed.reason;
  }
  return parsed.frame;
}

function paletteExactKey(palette, count) {
  var out = [];
  for (var i = 0; i < count; i++) out.push(palette[i][0], palette[i][1], palette[i][2]);
  return out.join(',');
}

function getPaletteLut(palette, count) {
  var key = paletteExactKey(palette, count);
  var entry = lutCache[count];
  if (entry.lut && entry.key === key) return entry.lut;
  entry.key = key;
  entry.lut = createPaletteLut(palette, count);
  return entry.lut;
}

async function findAprilTagMarkerGroups(image) {
  var detectorInstance = await getDetector();
  var list = detectorInstance.detect(toGrayscale(image), image.width, image.height) || [];
  var ids = [];
  var candidates = [];
  var grouped = [];
  for (var b = 0; b < TAG_BASES.length; b++) grouped[TAG_BASES[b]] = { tl: [], tr: [], bl: [], br: [] };

  for (var i = 0; i < list.length; i++) {
    var marker = list[i];
    ids.push(marker.id);
    for (var baseIndex = 0; baseIndex < TAG_BASES.length; baseIndex++) {
      var base = TAG_BASES[baseIndex];
      if (marker.id === base + 0) grouped[base].tl.push(marker);
      if (marker.id === base + 1) grouped[base].tr.push(marker);
      if (marker.id === base + 2) grouped[base].bl.push(marker);
      if (marker.id === base + 3) grouped[base].br.push(marker);
    }
  }

  var missing = [];
  var seenBase = {};
  for (var g = 0; g < TAG_BASES.length; g++) {
    var nextBase = TAG_BASES[g];
    if (seenBase[nextBase]) continue;
    seenBase[nextBase] = true;
    var found = grouped[nextBase];
    var missingForGroup = ['tl', 'tr', 'bl', 'br'].filter(function(key) { return !found[key].length; });
    if (missingForGroup.length) missing.push('base' + nextBase + ':' + missingForGroup.join('/'));
    candidates = candidates.concat(buildGroupCandidates(found, nextBase));
  }

  var groups = selectMarkerGroups(candidates).map(function(group) {
    return { slot: group.slot, marks: group.marks };
  });
  if (lastDebug) {
    lastDebug.apriltagFound = list.length;
    lastDebug.apriltagIds = ids.join(',');
    lastDebug.markerGroups = groups.length;
    lastDebug.missingMarkers = missing.join(' ');
  }
  return groups;
}

function buildGroupCandidates(found, base) {
  var out = [];
  for (var a = 0; a < found.tl.length; a++) {
    for (var b = 0; b < found.tr.length; b++) {
      for (var c = 0; c < found.bl.length; c++) {
        for (var d = 0; d < found.br.length; d++) {
          var marks = {
            tl: markerInfo(found.tl[a]),
            tr: markerInfo(found.tr[b]),
            bl: markerInfo(found.bl[c]),
            br: markerInfo(found.br[d])
          };
          var score = scoreMarkerGroup(marks);
          if (score < Infinity) {
            out.push({
              base: base,
              slot: base / 4,
              marks: marks,
              score: score,
              keys: [found.tl[a], found.tr[b], found.bl[c], found.br[d]].map(markerKey),
              cx: (marks.tl.cx + marks.tr.cx + marks.bl.cx + marks.br.cx) / 4,
              cy: (marks.tl.cy + marks.tr.cy + marks.bl.cy + marks.br.cy) / 4
            });
          }
        }
      }
    }
  }
  return out;
}

function scoreMarkerGroup(marks) {
  if (!(marks.tl.cx < marks.tr.cx && marks.bl.cx < marks.br.cx && marks.tl.cy < marks.bl.cy && marks.tr.cy < marks.br.cy)) return Infinity;
  var top = distance(marks.tl, marks.tr);
  var bottom = distance(marks.bl, marks.br);
  var left = distance(marks.tl, marks.bl);
  var right = distance(marks.tr, marks.br);
  var width = (top + bottom) / 2;
  var height = (left + right) / 2;
  if (width < 40 || height < 40) return Infinity;
  var skew = Math.abs(top - bottom) / width + Math.abs(left - right) / height + Math.abs(width - height) / Math.max(width, height);
  var cross = Math.abs((marks.tl.cy + marks.tr.cy) / 2 - (marks.bl.cy + marks.br.cy) / 2) / height;
  return skew + Math.abs(1 - cross) * 0.25;
}

function selectMarkerGroups(candidates) {
  var selected = [];
  var used = {};
  candidates.sort(function(a, b) { return a.score - b.score; });
  for (var i = 0; i < candidates.length; i++) {
    var candidate = candidates[i];
    var conflict = candidate.keys.some(function(key) { return used[key]; });
    if (conflict) continue;
    selected.push(candidate);
    candidate.keys.forEach(function(key) { used[key] = true; });
    if (selected.length >= TAG_BASES.length) break;
  }
  return selected;
}

function markerKey(marker) {
  var c = marker.center || averageCorners(marker.corners);
  return marker.id + '@' + Math.round(c.x) + ',' + Math.round(c.y);
}

function averageCorners(corners) {
  var cx = 0;
  var cy = 0;
  for (var i = 0; i < corners.length; i++) {
    cx += corners[i].x;
    cy += corners[i].y;
  }
  return { x: cx / corners.length, y: cy / corners.length };
}

function distance(a, b) {
  var dx = a.cx - b.cx;
  var dy = a.cy - b.cy;
  return Math.sqrt(dx * dx + dy * dy);
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
  var size = image.width * image.height;
  if (!grayScratch || grayScratchWidth !== image.width || grayScratchHeight !== image.height) {
    grayScratch = new Uint8Array(size);
    grayScratchWidth = image.width;
    grayScratchHeight = image.height;
  }
  for (var i = 0, j = 0; i < rgba.length; i += 4, j++) {
    grayScratch[j] = (rgba[i] * 77 + rgba[i + 1] * 150 + rgba[i + 2] * 29) >> 8;
  }
  return grayScratch;
}

function buildGridHomography(marks) {
  var src = [TAG_CENTER.tl, TAG_CENTER.tr, TAG_CENTER.br, TAG_CENTER.bl];
  var dst = [
    [marks.tl.cx, marks.tl.cy],
    [marks.tr.cx, marks.tr.cy],
    [marks.br.cx, marks.br.cy],
    [marks.bl.cx, marks.bl.cy]
  ];
  return solveHomography(src, dst);
}

function projectedDataBox(h) {
  return projectedBox(h, DATA_OFFSET_X, DATA_OFFSET_Y, DATA_COLS, DATA_ROWS, 0.9);
}

function projectedGridBox(h) {
  return projectedBox(h, 0, 0, TOTAL_COLS, TOTAL_ROWS, 0.92);
}

function projectedBox(h, x, y, width, height, confidence) {
  var pts = [
    project(h, x, y),
    project(h, x + width, y),
    project(h, x + width, y + height),
    project(h, x, y + height)
  ];
  if (!pts[0] || !pts[1] || !pts[2] || !pts[3]) return { x: 0, y: 0, width: 0, height: 0, confidence: 0 };
  var minX = Math.min(pts[0].x, pts[1].x, pts[2].x, pts[3].x);
  var maxX = Math.max(pts[0].x, pts[1].x, pts[2].x, pts[3].x);
  var minY = Math.min(pts[0].y, pts[1].y, pts[2].y, pts[3].y);
  var maxY = Math.max(pts[0].y, pts[1].y, pts[2].y, pts[3].y);
  return { x: minX, y: minY, width: maxX - minX, height: maxY - minY, confidence: confidence };
}

function calibratePalette(data, w, h, homography) {
  var sums = PALETTE.map(function() { return [0, 0, 0, 0]; });
  var rows = [3.5, TOTAL_ROWS - 3.5];
  for (var r = 0; r < rows.length; r++) {
    for (var i = 0; i < DATA_COLS; i++) {
      var colorIndex = i % 8;
      var p = project(homography, DATA_OFFSET_X + i + 0.5, rows[r]);
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

  var symbolIndex = readU32(frame, 8);
  var sourceSymbols = readU32(frame, 12);
  var transferLength = readU32(frame, 16);
  var packetLen = readU16(frame, 20);
  var checksum = readU32(frame, 22);
  var payloadBytes = readU16(frame, 26);
  var mtu = readU16(frame, 28);
  var repairPacketsPerBlock = readU16(frame, 30);
  var cycleSymbols = readU32(frame, 32);
  var dataCols = readU16(frame, 36);
  var dataRows = readU16(frame, 38);
  var packetIndex = readU32(frame, 40);
  var transferIdLo = readU32(frame, 48);
  var transferIdHi = readU32(frame, 52);
  var expectedPayload = (bits === 3 ? FRAME_BYTES_3 : FRAME_BYTES_2) - HEADER_BYTES;

  if (lastDebug) {
    lastDebug.parsedBits = bits;
    lastDebug.parsedSourceSymbols = sourceSymbols;
    lastDebug.parsedSymbolIndex = symbolIndex;
    lastDebug.parsedPacketIndex = packetIndex;
    lastDebug.parsedPacketLen = packetLen;
  }

  if (sourceSymbols < 1 || transferLength < 1 || packetLen < 5 || packetLen > expectedPayload) {
    return { frame: null, reason: 'header packet=' + packetLen + ' src=' + sourceSymbols + ' len=' + transferLength };
  }
  if (payloadBytes !== expectedPayload || mtu + 4 > payloadBytes) {
    return { frame: null, reason: 'payload payload=' + payloadBytes + ' mtu=' + mtu + ' expected=' + expectedPayload };
  }
  if (dataCols !== DATA_COLS || dataRows !== DATA_ROWS) {
    return { frame: null, reason: 'geometry data=' + dataCols + 'x' + dataRows };
  }

  var actualChecksum = crc32cFrame(frame, HEADER_BYTES + packetLen);
  if (actualChecksum !== checksum) return { frame: null, reason: 'checksum want=' + checksum + ' got=' + actualChecksum };

  var packet = frame.slice(HEADER_BYTES, HEADER_BYTES + packetLen);
  var gridBox = projectedGridBox(homography);
  var dataBox = projectedDataBox(homography);
  return {
    frame: {
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
      transferId: formatTransferId(transferIdHi, transferIdLo),
      bbox: gridBox,
      dataBox: dataBox,
      packet: packet.buffer
    },
    reason: 'ok'
  };
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

function createPaletteLut(palette, count) {
  var lut = new Uint8Array(32 * 32 * 32);
  for (var r = 0; r < 32; r++) {
    for (var g = 0; g < 32; g++) {
      for (var b = 0; b < 32; b++) {
        lut[(r << 10) | (g << 5) | b] = nearestPalette([r * 8 + 4, g * 8 + 4, b * 8 + 4], palette, count);
      }
    }
  }
  return lut;
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

var CRC32C_TABLE = (function() {
  var table = new Uint32Array(256);
  for (var i = 0; i < 256; i++) {
    var crc = i;
    for (var j = 0; j < 8; j++) crc = (crc & 1) ? (0x82f63b78 ^ (crc >>> 1)) : (crc >>> 1);
    table[i] = crc >>> 0;
  }
  return table;
})();

function crc32cFrame(bytes, length) {
  var crc = 0xffffffff;
  var end = Math.min(bytes.length, length);
  for (var i = 0; i < end; i++) {
    var value = (i >= 22 && i < 26) ? 0 : bytes[i];
    crc = CRC32C_TABLE[(crc ^ value) & 255] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function formatTransferId(hi, lo) {
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
}

function miss(reason) {
  lastMissReason = reason;
  if (lastDebug) lastDebug.stage = reason;
  return null;
}

function formatBox(box) {
  return [Math.round(box.x), Math.round(box.y), Math.round(box.width), Math.round(box.height)].join(',');
}

function readU16(buf, offset) {
  return buf[offset] | (buf[offset + 1] << 8);
}

function readU32(buf, offset) {
  return (buf[offset] | (buf[offset + 1] << 8) | (buf[offset + 2] << 16) | (buf[offset + 3] << 24)) >>> 0;
}
