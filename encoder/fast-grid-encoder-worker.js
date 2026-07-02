var DATA_CELLS = 64;
var HEADER_BYTES = 48;
var PROTOCOL_VERSION = 7;
var STREAM_VERSION = 4;
var FLAG_FOLDER = 4;
var FLAG_GZIP = 8;

var fileName = '';
var fileSize = 0;
var sourceKind = 'file';
var streamFlags = 0;
var compressionKind = 'none';
var compressedSize = 0;
var colorBits = 2;
var frameBytes = getFrameBytes(colorBits);
var payloadBytes = frameBytes - HEADER_BYTES;
var rqMtu = payloadBytes - 4;
var payloadSegments = [];
var streamHeader = null;
var streamBytes = null;
var streamLength = 0;
var sourceSymbols = 0;
var repairPacketsPerBlock = 0;
var packets = [];
var packetSchedule = [];
var raptorReady = null;
var RaptorEncoder = null;

self.onmessage = function(event) {
  var msg = event.data;
  if (!msg) return;
  if (msg.type === 'load' && msg.file) {
    setColorBits(msg.colorBits);
    loadFile(msg.file).catch(postWorkerError);
  } else if (msg.type === 'load' && msg.files) {
    setColorBits(msg.colorBits);
    loadFolder(msg.files).catch(postWorkerError);
  } else if (msg.type === 'frame') {
    buildFrame(msg.symbolIndex == null ? msg.index : msg.symbolIndex).catch(postWorkerError);
  }
};

function setColorBits(bits) {
  colorBits = bits === 3 ? 3 : 2;
  frameBytes = getFrameBytes(colorBits);
  payloadBytes = frameBytes - HEADER_BYTES;
  rqMtu = payloadBytes - 4;
}

async function initRaptor() {
  if (!raptorReady) {
    raptorReady = import('../vendor/raptorq/raptorq.js').then(async function(mod) {
      await mod.default(new URL('../vendor/raptorq/raptorq_bg.wasm', self.location.href));
      RaptorEncoder = mod.Encoder;
    });
  }
  return raptorReady;
}

async function loadFile(nextFile) {
  fileName = nextFile.name || 'file.bin';
  fileSize = nextFile.size || 0;
  sourceKind = 'file';
  payloadSegments = [{ type: 'file', file: nextFile, offset: 0, length: fileSize }];
  await prepareStream(fileName, fileSize);
}

async function loadFolder(files) {
  var list = Array.prototype.slice.call(files || []).filter(function(f) { return f && f.size >= 0; });
  var root = getFolderRoot(list) || 'folder';
  sourceKind = 'folder';
  fileName = root + '.tar';
  payloadSegments = buildTarSegments(list);
  fileSize = payloadSegments.reduce(function(sum, segment) { return sum + segment.length; }, 0);
  await prepareStream(fileName, fileSize);
}

async function prepareStream(name, size) {
  await initRaptor();

  var nameBytes = new TextEncoder().encode(name);
  streamHeader = new Uint8Array(48 + nameBytes.length);
  streamHeader[0] = 70; streamHeader[1] = 71; streamHeader[2] = 83; streamHeader[3] = 50; // FGS2
  streamHeader[4] = STREAM_VERSION;
  streamFlags = sourceKind === 'folder' ? FLAG_FOLDER : 0;
  writeU16(streamHeader, 6, nameBytes.length);
  writeU32(streamHeader, 8, size);
  writeU32(streamHeader, 12, 32);
  streamHeader.set(nameBytes, 48);

  var sourceBytes = new Uint8Array(size);
  await fillPayloadRange(sourceBytes, 0, 0, size);
  var digest = new Uint8Array(await crypto.subtle.digest('SHA-256', sourceBytes));
  var transferBytes = await maybeCompress(sourceBytes);
  compressionKind = transferBytes === sourceBytes ? 'none' : 'gzip';
  compressedSize = transferBytes.length;
  if (compressionKind === 'gzip') streamFlags |= FLAG_GZIP;
  streamHeader[5] = streamFlags;
  streamBytes = new Uint8Array(streamHeader.length + transferBytes.length);
  streamLength = streamBytes.length;
  streamBytes.set(streamHeader, 0);
  streamBytes.set(digest, 16);
  streamBytes.set(transferBytes, streamHeader.length);

  sourceSymbols = Math.ceil(streamLength / rqMtu);
  repairPacketsPerBlock = Math.min(512, Math.max(16, Math.ceil(sourceSymbols * 0.22)));

  var encoder = RaptorEncoder.with_defaults(streamBytes, rqMtu);
  packets = encoder.encode(repairPacketsPerBlock);
  packetSchedule = buildPacketSchedule(sourceSymbols, packets.length);
  encoder.free();

  self.postMessage({
    type: 'loaded',
    meta: {
      name: fileName,
      fileSize: fileSize,
      kind: sourceKind,
      compression: compressionKind,
      compressedSize: compressedSize,
      streamLength: streamLength,
      totalFrames: sourceSymbols,
      cycleSymbols: packetSchedule.length,
      payloadBytes: payloadBytes,
      raptorPacketBytes: rqMtu + 4,
      headerBytes: HEADER_BYTES,
      dataCells: DATA_CELLS,
      colorBits: colorBits,
      raptorq: true,
      repairPacketsPerBlock: repairPacketsPerBlock
    }
  });
}

async function maybeCompress(bytes) {
  if (typeof CompressionStream === 'undefined') return bytes;
  try {
    var compressed = new Uint8Array(await new Response(new Blob([bytes]).stream().pipeThrough(new CompressionStream('gzip'))).arrayBuffer());
    return compressed.length + 32 < bytes.length ? compressed : bytes;
  } catch (err) {
    return bytes;
  }
}

async function buildFrame(symbolIndex) {
  symbolIndex = Math.floor(Number(symbolIndex));
  if (!packets.length || !packetSchedule.length || !isFinite(symbolIndex) || symbolIndex < 0) return;
  var scheduleIndex = symbolIndex % packetSchedule.length;
  var packetIndex = packetSchedule[scheduleIndex];
  var packet = packets[packetIndex];
  if (packet.length > payloadBytes) throw new Error('RaptorQ packet exceeds visual payload');

  var frame = new Uint8Array(frameBytes);
  frame[0] = 70; frame[1] = 71; frame[2] = 70; frame[3] = 50; // FGF2
  frame[4] = PROTOCOL_VERSION;
  frame[5] = colorBits;
  writeU16(frame, 6, 0);
  writeU32(frame, 8, symbolIndex >>> 0);
  writeU32(frame, 12, sourceSymbols >>> 0);
  writeU32(frame, 16, streamLength >>> 0);
  writeU16(frame, 20, packet.length);
  writeU32(frame, 22, checksum32(packet));
  writeU16(frame, 26, payloadBytes);
  writeU16(frame, 28, rqMtu);
  writeU16(frame, 30, repairPacketsPerBlock);
  writeU32(frame, 32, packetSchedule.length >>> 0);
  writeU16(frame, 36, DATA_CELLS);
  writeU16(frame, 38, HEADER_BYTES);
  writeU32(frame, 40, packetIndex >>> 0);
  writeU32(frame, 44, scheduleIndex >>> 0);
  frame.set(packet, HEADER_BYTES);

  self.postMessage({
    type: 'frame',
    symbolIndex: symbolIndex,
    frame: frame.buffer,
    plan: { kind: 'raptorq', packetIndex: packetIndex, scheduleIndex: scheduleIndex }
  }, [frame.buffer]);
}

function buildPacketSchedule(sourceCount, totalCount) {
  var schedule = [];
  var repairStart = Math.min(sourceCount, totalCount);
  var repairCount = Math.max(0, totalCount - repairStart);
  if (!repairCount) {
    for (var all = 0; all < totalCount; all++) schedule.push(all);
    return schedule;
  }

  var repairEvery = Math.max(4, Math.ceil(sourceCount / repairCount));
  var nextRepair = repairStart;
  for (var i = 0; i < repairStart; i++) {
    schedule.push(i);
    if ((i + 1) % repairEvery === 0 && nextRepair < totalCount) {
      schedule.push(nextRepair++);
    }
  }
  while (nextRepair < totalCount) schedule.push(nextRepair++);
  return schedule;
}

function getFrameBytes(bits) {
  return DATA_CELLS * DATA_CELLS * bits / 8;
}

function postWorkerError(err) {
  self.postMessage({
    type: 'error',
    message: err && err.message ? err.message : String(err || 'worker error')
  });
}

async function fillPayloadRange(target, targetOffset, payloadOffset, length) {
  var end = payloadOffset + length;
  for (var i = findSegmentIndex(payloadOffset); i < payloadSegments.length; i++) {
    var segment = payloadSegments[i];
    var segmentStart = segment.offset;
    var segmentEnd = segment.offset + segment.length;
    if (segmentEnd <= payloadOffset) continue;
    if (segmentStart >= end) break;

    var from = Math.max(payloadOffset, segmentStart);
    var to = Math.min(end, segmentEnd);
    var len = to - from;
    var writeAt = targetOffset + (from - payloadOffset);
    var inside = from - segmentStart;

    if (segment.type === 'bytes') {
      target.set(segment.bytes.subarray(inside, inside + len), writeAt);
    } else if (segment.type === 'zero') {
      target.fill(0, writeAt, writeAt + len);
    } else if (segment.type === 'file') {
      var bytes = new Uint8Array(await segment.file.slice(inside, inside + len).arrayBuffer());
      target.set(bytes, writeAt);
    }
  }
}

function findSegmentIndex(offset) {
  var lo = 0;
  var hi = payloadSegments.length - 1;
  var best = 0;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    var segment = payloadSegments[mid];
    if (segment.offset + segment.length <= offset) {
      lo = mid + 1;
    } else {
      best = mid;
      hi = mid - 1;
    }
  }
  return best;
}

function buildTarSegments(files) {
  var segments = [];
  var offset = 0;
  files.sort(function(a, b) {
    return getRelativePath(a).localeCompare(getRelativePath(b));
  });

  files.forEach(function(nextFile) {
    var name = normalizeTarPath(getRelativePath(nextFile));
    var header = buildTarHeader(name, nextFile.size, nextFile.lastModified || Date.now());
    segments.push({ type: 'bytes', bytes: header, offset: offset, length: header.length });
    offset += header.length;
    segments.push({ type: 'file', file: nextFile, offset: offset, length: nextFile.size });
    offset += nextFile.size;
    var pad = (512 - (nextFile.size % 512)) % 512;
    if (pad) {
      segments.push({ type: 'zero', offset: offset, length: pad });
      offset += pad;
    }
  });

  segments.push({ type: 'zero', offset: offset, length: 1024 });
  return segments;
}

function buildTarHeader(name, size, mtimeMs) {
  var header = new Uint8Array(512);
  var pathParts = splitTarPath(name);
  writeString(header, 0, 100, pathParts.name);
  writeOctal(header, 100, 8, 0o644);
  writeOctal(header, 108, 8, 0);
  writeOctal(header, 116, 8, 0);
  writeOctal(header, 124, 12, size);
  writeOctal(header, 136, 12, Math.floor(mtimeMs / 1000));
  for (var i = 148; i < 156; i++) header[i] = 32;
  header[156] = 48;
  writeString(header, 257, 6, 'ustar');
  writeString(header, 263, 2, '00');
  writeString(header, 345, 155, pathParts.prefix);
  var sum = 0;
  for (var j = 0; j < header.length; j++) sum += header[j];
  writeChecksum(header, sum);
  return header;
}

function splitTarPath(path) {
  if (byteLength(path) <= 100) return { name: path, prefix: '' };
  var slash = path.lastIndexOf('/');
  while (slash > 0) {
    var prefix = path.slice(0, slash);
    var name = path.slice(slash + 1);
    if (byteLength(name) <= 100 && byteLength(prefix) <= 155) return { name: name, prefix: prefix };
    slash = path.lastIndexOf('/', slash - 1);
  }
  return { name: path.slice(-100), prefix: '' };
}

function getFolderRoot(files) {
  if (!files.length) return '';
  var path = getRelativePath(files[0]);
  return path.split('/')[0] || 'folder';
}

function getRelativePath(nextFile) {
  return nextFile.webkitRelativePath || nextFile.name || 'file.bin';
}

function normalizeTarPath(path) {
  return path.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\.\./g, '_') || 'file.bin';
}

function writeString(buf, offset, length, text) {
  var bytes = new TextEncoder().encode(text);
  buf.set(bytes.subarray(0, length), offset);
}

function writeOctal(buf, offset, length, value) {
  var text = Math.floor(value).toString(8).padStart(length - 1, '0').slice(-(length - 1));
  writeString(buf, offset, length - 1, text);
  buf[offset + length - 1] = 0;
}

function writeChecksum(buf, value) {
  var text = value.toString(8).padStart(6, '0').slice(-6);
  writeString(buf, 148, 6, text);
  buf[154] = 0;
  buf[155] = 32;
}

function byteLength(text) {
  return new TextEncoder().encode(text).length;
}

function writeU16(buf, offset, value) {
  buf[offset] = value & 255;
  buf[offset + 1] = (value >>> 8) & 255;
}

function writeU32(buf, offset, value) {
  buf[offset] = value & 255;
  buf[offset + 1] = (value >>> 8) & 255;
  buf[offset + 2] = (value >>> 16) & 255;
  buf[offset + 3] = (value >>> 24) & 255;
}

function checksum32(bytes) {
  var h = 2166136261 >>> 0;
  for (var i = 0; i < bytes.length; i++) {
    h ^= bytes[i];
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h >>> 0;
}
