importScripts('../shared/protocol.js');

var P = self.FastGridProtocol;
var TOTAL_COLS = P.totalCols;
var TOTAL_ROWS = P.totalRows;
var DATA_OFFSET_X = P.dataOffsetX;
var DATA_OFFSET_Y = P.dataOffsetY;
var DATA_COLS = P.dataCols;
var DATA_ROWS = P.dataRows;
var HEADER_BYTES = P.headerBytes;
var PROTOCOL_VERSION = P.protocolVersion;
var STREAM_VERSION = 4;
var FLAG_FOLDER = 4;
var FLAG_GZIP = 8;
var RAPTOR_CHUNK_BYTES = 16 * 1024 * 1024;
var MAX_RAPTOR_BLOCKS = 255;
var PACKET_CACHE_BLOCKS = 2;
var RAPTOR_PREFETCH_SYMBOLS = 64;
// Compression needs a complete input buffer in current browser APIs.  Keep it
// for quick, small transfers, but do not make loading a multi-GB file depend on
// allocating several full-size copies of that file.
var LARGE_FILE_STREAM_THRESHOLD = 32 * 1024 * 1024;
var HASH_READ_BYTES = 4 * 1024 * 1024;

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
var streamedPayload = false;
var streamLength = 0;
var sourceSymbols = 0;
var repairPacketsPerBlock = 0;
var raptorBlocks = [];
var totalSourceSymbols = 0;
var cycleSymbols = 0;
var packetCache = new Map();
var packetBuilds = new Map();
var raptorReady = null;
var RaptorEncoder = null;
var transferIdLo = 0;
var transferIdHi = 0;
var sourceFileCount = 0;

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
  colorBits = bits === 3 || bits === 8 ? 3 : 2;
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
  var startedAt = performance.now();
  fileName = nextFile.name || 'file.bin';
  fileSize = nextFile.size || 0;
  sourceFileCount = 1;
  sourceKind = 'file';
  payloadSegments = [{ type: 'file', file: nextFile, offset: 0, length: fileSize }];
  await prepareStream(fileName, fileSize, startedAt);
}

async function loadFolder(files) {
  var startedAt = performance.now();
  var list = Array.prototype.slice.call(files || []).filter(function(f) { return f && f.size >= 0; });
  sourceFileCount = list.length;
  postPrepareProgress('Indexing folder', sourceFileCount + ' files', 3, startedAt);
  var root = getFolderRoot(list) || 'folder';
  sourceKind = 'folder';
  fileName = root + '.tar';
  payloadSegments = buildTarSegments(list);
  fileSize = payloadSegments.reduce(function(sum, segment) { return sum + segment.length; }, 0);
  await prepareStream(fileName, fileSize, startedAt);
}

async function prepareStream(name, size, prepareStartedAt) {
  postPrepareProgress('Reading source', sourceKind === 'folder' ? sourceFileCount + ' files' : name, 10, prepareStartedAt);
  var raptorPromise = initRaptor();
  generateTransferId();

  var nameBytes = new TextEncoder().encode(name);
  streamHeader = new Uint8Array(48 + nameBytes.length);
  streamHeader[0] = 70; streamHeader[1] = 71; streamHeader[2] = 83; streamHeader[3] = 50;
  streamHeader[4] = STREAM_VERSION;
  streamFlags = sourceKind === 'folder' ? FLAG_FOLDER : 0;
  streamHeader[5] = streamFlags;
  writeU16(streamHeader, 6, nameBytes.length);
  writeU32(streamHeader, 8, size);
  writeU32(streamHeader, 12, 32);
  streamHeader.set(nameBytes, 48);

  postPrepareProgress('Calculating SHA-256', formatBytes(size), 35, prepareStartedAt);
  var digest;
  var transferBytes = null;
  streamedPayload = size > LARGE_FILE_STREAM_THRESHOLD;
  if (streamedPayload) {
    digest = await hashPayloadIncrementally(size, prepareStartedAt);
    compressionKind = 'none';
    compressedSize = size;
    streamHeader.set(digest, 16);
    streamLength = streamHeader.length + size;
    streamBytes = null;
    postPrepareProgress('Using on-demand file blocks', formatBytes(size) + ', no full-file copy', 62, prepareStartedAt);
  } else {
    var sourceBytes = await materializePayload(size);
    digest = new Uint8Array(await crypto.subtle.digest('SHA-256', sourceBytes));
    postPrepareProgress('Compressing stream', formatBytes(size), 55, prepareStartedAt);
    transferBytes = await maybeCompress(sourceBytes);
    compressionKind = transferBytes === sourceBytes ? 'none' : 'gzip';
    compressedSize = transferBytes.length;
    if (compressionKind === 'gzip') streamFlags |= FLAG_GZIP;
    streamHeader.set(digest, 16);
    streamHeader[5] = streamFlags;
    streamBytes = new Uint8Array(streamHeader.length + transferBytes.length);
    streamLength = streamBytes.length;
    streamBytes.set(streamHeader, 0);
    streamBytes.set(transferBytes, streamHeader.length);
  }

  buildRaptorBlocks();
  postPrepareProgress('Initializing RaptorQ', raptorBlocks.length + ' chunks, ' + totalSourceSymbols + ' source symbols', 75, prepareStartedAt);
  await raptorPromise;
  postPrepareProgress('Preparing first RaptorQ chunk', raptorBlocks.length + ' chunks total', 88, prepareStartedAt);
  await getBlockPackets(0);

  self.postMessage({
    type: 'loaded',
    meta: {
      name: fileName,
      fileSize: fileSize,
      kind: sourceKind,
      compression: compressionKind,
      compressedSize: compressedSize,
      streamLength: streamLength,
      totalFrames: totalSourceSymbols,
      cycleSymbols: cycleSymbols,
      payloadBytes: payloadBytes,
      raptorPacketBytes: rqMtu + 4,
      headerBytes: HEADER_BYTES,
      dataCols: DATA_COLS,
      dataRows: DATA_ROWS,
      colorBits: colorBits,
      raptorq: true,
      repairPacketsPerBlock: repairPacketsPerBlock,
      raptorBlocks: raptorBlocks.length,
      raptorChunkBytes: RAPTOR_CHUNK_BYTES,
      sourceFileCount: sourceFileCount,
      prepareMs: performance.now() - prepareStartedAt,
      transferId: formatTransferId(transferIdHi, transferIdLo)
    }
  });
}

async function materializePayload(size) {
  if (payloadSegments.length === 1 && payloadSegments[0].type === 'file' && payloadSegments[0].length === size) {
    return new Uint8Array(await payloadSegments[0].file.arrayBuffer());
  }
  var parts = payloadSegments.map(function(segment) {
    if (segment.type === 'bytes') return segment.bytes;
    if (segment.type === 'file') return segment.file;
    return new Uint8Array(segment.length);
  });
  return new Uint8Array(await new Blob(parts).arrayBuffer());
}

async function hashPayloadIncrementally(size, startedAt) {
  var hash = new Sha256();
  var total = Math.max(1, size);
  for (var offset = 0; offset < size; offset += HASH_READ_BYTES) {
    var length = Math.min(HASH_READ_BYTES, size - offset);
    hash.update(await readPayloadRange(offset, length));
    var percent = 35 + Math.floor(((offset + length) / total) * 23);
    postPrepareProgress('Calculating SHA-256', formatBytes(offset + length) + ' / ' + formatBytes(size), percent, startedAt);
    // Let cancellation/reload messages and progress painting run between disk reads.
    if (offset + length < size) await new Promise(function(resolve) { setTimeout(resolve, 0); });
  }
  return hash.digest();
}

function postPrepareProgress(stage, detail, percent, startedAt) {
  self.postMessage({
    type: 'prepare-progress',
    stage: stage,
    detail: detail || '',
    percent: percent,
    elapsedMs: performance.now() - startedAt
  });
}

function formatBytes(value) {
  if (value < 1024) return value + ' B';
  if (value < 1024 * 1024) return (value / 1024).toFixed(1) + ' KB';
  return (value / (1024 * 1024)).toFixed(1) + ' MB';
}

function buildRaptorBlocks() {
  var blockCount = Math.ceil(streamLength / RAPTOR_CHUNK_BYTES);
  if (blockCount > MAX_RAPTOR_BLOCKS) throw new Error('Transfer is too large; maximum encoded stream size is ' + formatBytes(RAPTOR_CHUNK_BYTES * MAX_RAPTOR_BLOCKS));
  raptorBlocks = [];
  packetCache = new Map();
  packetBuilds = new Map();
  totalSourceSymbols = 0;
  cycleSymbols = 0;
  repairPacketsPerBlock = 0;
  for (var blockIndex = 0; blockIndex < blockCount; blockIndex++) {
    var offset = blockIndex * RAPTOR_CHUNK_BYTES;
    var length = Math.min(RAPTOR_CHUNK_BYTES, streamLength - offset);
    var blockSourceSymbols = Math.ceil(length / rqMtu);
    var repairs = Math.min(512, Math.max(16, Math.ceil(blockSourceSymbols * 0.22)));
    var schedule = buildPacketSchedule(blockSourceSymbols, blockSourceSymbols + repairs);
    raptorBlocks.push({
      index: blockIndex,
      offset: offset,
      length: length,
      sourceSymbols: blockSourceSymbols,
      sourceOffset: totalSourceSymbols,
      repairPackets: repairs,
      cycleOffset: cycleSymbols,
      schedule: schedule
    });
    totalSourceSymbols += blockSourceSymbols;
    cycleSymbols += schedule.length;
    repairPacketsPerBlock = Math.max(repairPacketsPerBlock, repairs);
  }
  sourceSymbols = totalSourceSymbols;
}

async function getBlockPackets(blockIndex) {
  if (packetCache.has(blockIndex)) {
    var cached = packetCache.get(blockIndex);
    packetCache.delete(blockIndex);
    packetCache.set(blockIndex, cached);
    return cached;
  }
  if (packetBuilds.has(blockIndex)) return packetBuilds.get(blockIndex);
  var pending = createBlockPackets(blockIndex);
  packetBuilds.set(blockIndex, pending);
  try {
    return await pending;
  } finally {
    packetBuilds.delete(blockIndex);
  }
}

async function createBlockPackets(blockIndex) {
  var block = raptorBlocks[blockIndex];
  if (!block) throw new Error('Invalid RaptorQ chunk ' + blockIndex);
  var blockBytes = await readStreamRange(block.offset, block.length);
  var encoder = RaptorEncoder.with_defaults(blockBytes, rqMtu);
  var nextPackets;
  try {
    nextPackets = encoder.encode(block.repairPackets);
  } finally {
    encoder.free();
  }
  if (nextPackets.length !== block.schedule.length) {
    throw new Error('RaptorQ chunk ' + (blockIndex + 1) + ' returned ' + nextPackets.length + ' packets; expected ' + block.schedule.length);
  }
  for (var packetIndex = 0; packetIndex < nextPackets.length; packetIndex++) {
    if (!nextPackets[packetIndex]) throw new Error('RaptorQ chunk ' + (blockIndex + 1) + ' returned an empty packet at ' + packetIndex);
  }
  packetCache.set(blockIndex, nextPackets);
  while (packetCache.size > PACKET_CACHE_BLOCKS) packetCache.delete(packetCache.keys().next().value);
  return nextPackets;
}

function findRaptorBlock(scheduleIndex) {
  var lo = 0;
  var hi = raptorBlocks.length - 1;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    var block = raptorBlocks[mid];
    if (scheduleIndex < block.cycleOffset) hi = mid - 1;
    else if (scheduleIndex >= block.cycleOffset + block.schedule.length) lo = mid + 1;
    else return block;
  }
  return null;
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
  if (!raptorBlocks.length || !cycleSymbols || !isFinite(symbolIndex) || symbolIndex < 0) return;
  var scheduleIndex = symbolIndex % cycleSymbols;
  var block = findRaptorBlock(scheduleIndex);
  if (!block) throw new Error('No RaptorQ chunk for visual symbol ' + scheduleIndex);
  var localScheduleIndex = scheduleIndex - block.cycleOffset;
  var packetIndex = block.schedule[localScheduleIndex];
  var blockPackets = await getBlockPackets(block.index);
  if (block.index + 1 < raptorBlocks.length && localScheduleIndex >= block.schedule.length - RAPTOR_PREFETCH_SYMBOLS) {
    getBlockPackets(block.index + 1).catch(function() {});
  }
  var packet = blockPackets[packetIndex];
  if (!packet) throw new Error('RaptorQ chunk ' + (block.index + 1) + ' packet ' + packetIndex + ' is unavailable');
  if (packet.length > payloadBytes) throw new Error('RaptorQ packet exceeds visual payload');

  var frame = new Uint8Array(frameBytes);
  frame[0] = 70; frame[1] = 71; frame[2] = 70; frame[3] = 50;
  frame[4] = PROTOCOL_VERSION;
  frame[5] = colorBits;
  frame[6] = block.index;
  frame[7] = raptorBlocks.length;
  writeU32(frame, 8, symbolIndex >>> 0);
  writeU32(frame, 12, block.sourceSymbols >>> 0);
  writeU32(frame, 16, block.length >>> 0);
  writeU16(frame, 20, packet.length);
  writeU32(frame, 22, 0);
  writeU16(frame, 26, payloadBytes);
  writeU16(frame, 28, rqMtu);
  writeU16(frame, 30, block.repairPackets);
  writeU32(frame, 32, totalSourceSymbols >>> 0);
  writeU16(frame, 36, DATA_COLS);
  writeU16(frame, 38, DATA_ROWS);
  writeU32(frame, 40, packetIndex >>> 0);
  writeU32(frame, 44, block.sourceOffset >>> 0);
  writeU32(frame, 48, transferIdLo);
  writeU32(frame, 52, transferIdHi);
  frame.set(packet, HEADER_BYTES);
  writeU32(frame, 22, crc32cFrame(frame, HEADER_BYTES + packet.length));

  self.postMessage({
    type: 'frame',
    symbolIndex: symbolIndex,
    frame: frame.buffer,
    plan: { kind: 'raptorq', blockIndex: block.index, packetIndex: packetIndex, scheduleIndex: scheduleIndex }
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
    if ((i + 1) % repairEvery === 0 && nextRepair < totalCount) schedule.push(nextRepair++);
  }
  while (nextRepair < totalCount) schedule.push(nextRepair++);
  return schedule;
}

function getFrameBytes(bits) {
  return DATA_COLS * DATA_ROWS * bits / 8;
}

function postWorkerError(err) {
  self.postMessage({ type: 'error', message: err && err.message ? err.message : String(err || 'worker error') });
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

async function readPayloadRange(payloadOffset, length) {
  var bytes = new Uint8Array(length);
  await fillPayloadRange(bytes, 0, payloadOffset, length);
  return bytes;
}

async function readStreamRange(offset, length) {
  if (streamBytes) return streamBytes.subarray(offset, offset + length);
  var bytes = new Uint8Array(length);
  var headerEnd = streamHeader.length;
  if (offset < headerEnd) {
    var headerLength = Math.min(length, headerEnd - offset);
    bytes.set(streamHeader.subarray(offset, offset + headerLength), 0);
  }
  var payloadStart = Math.max(offset, headerEnd);
  var payloadEnd = offset + length;
  if (payloadEnd > payloadStart) {
    await fillPayloadRange(bytes, payloadStart - offset, payloadStart - headerEnd, payloadEnd - payloadStart);
  }
  return bytes;
}

function findSegmentIndex(offset) {
  var lo = 0;
  var hi = payloadSegments.length - 1;
  var best = 0;
  while (lo <= hi) {
    var mid = (lo + hi) >> 1;
    var segment = payloadSegments[mid];
    if (segment.offset + segment.length <= offset) lo = mid + 1;
    else { best = mid; hi = mid - 1; }
  }
  return best;
}

function buildTarSegments(files) {
  var segments = [];
  var offset = 0;
  files.sort(function(a, b) { return getRelativePath(a).localeCompare(getRelativePath(b)); });

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

function generateTransferId() {
  var words = new Uint32Array(2);
  crypto.getRandomValues(words);
  transferIdLo = words[0] >>> 0;
  transferIdHi = words[1] >>> 0;
  if (!transferIdLo && !transferIdHi) transferIdLo = 1;
}

function formatTransferId(hi, lo) {
  return hi.toString(16).padStart(8, '0') + lo.toString(16).padStart(8, '0');
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

// Incremental SHA-256 keeps the large-file path bounded by the read chunk size.
// WebCrypto's subtle.digest is intentionally used above for small inputs, but it
// only accepts a complete ArrayBuffer and would otherwise force a second copy of
// the selected file into memory.
var SHA256_K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

function Sha256() {
  this.state = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  this.words = new Uint32Array(64);
  this.buffer = new Uint8Array(64);
  this.bufferLength = 0;
  this.bytesHashed = 0;
}

Sha256.prototype.update = function(bytes) {
  if (!bytes || !bytes.length) return;
  this.bytesHashed += bytes.length;
  var offset = 0;
  if (this.bufferLength) {
    var needed = 64 - this.bufferLength;
    var copied = Math.min(needed, bytes.length);
    this.buffer.set(bytes.subarray(0, copied), this.bufferLength);
    this.bufferLength += copied;
    offset += copied;
    if (this.bufferLength === 64) {
      this.compress(this.buffer, 0);
      this.bufferLength = 0;
    }
  }
  while (offset + 64 <= bytes.length) {
    this.compress(bytes, offset);
    offset += 64;
  }
  if (offset < bytes.length) {
    this.buffer.set(bytes.subarray(offset), 0);
    this.bufferLength = bytes.length - offset;
  }
};

Sha256.prototype.digest = function() {
  var bitLength = this.bytesHashed * 8;
  var lengthHigh = Math.floor(bitLength / 0x100000000) >>> 0;
  var lengthLow = bitLength >>> 0;
  this.buffer[this.bufferLength++] = 0x80;
  if (this.bufferLength > 56) {
    this.buffer.fill(0, this.bufferLength);
    this.compress(this.buffer, 0);
    this.bufferLength = 0;
  }
  this.buffer.fill(0, this.bufferLength, 56);
  writeU32BE(this.buffer, 56, lengthHigh);
  writeU32BE(this.buffer, 60, lengthLow);
  this.compress(this.buffer, 0);
  var out = new Uint8Array(32);
  for (var i = 0; i < 8; i++) writeU32BE(out, i * 4, this.state[i]);
  return out;
};

Sha256.prototype.compress = function(bytes, offset) {
  var w = this.words;
  for (var i = 0; i < 16; i++) w[i] = readU32BE(bytes, offset + i * 4);
  for (var j = 16; j < 64; j++) {
    var x = w[j - 15];
    var y = w[j - 2];
    var s0 = ((x >>> 7) | (x << 25)) ^ ((x >>> 18) | (x << 14)) ^ (x >>> 3);
    var s1 = ((y >>> 17) | (y << 15)) ^ ((y >>> 19) | (y << 13)) ^ (y >>> 10);
    w[j] = (w[j - 16] + s0 + w[j - 7] + s1) >>> 0;
  }
  var a = this.state[0], b = this.state[1], c = this.state[2], d = this.state[3];
  var e = this.state[4], f = this.state[5], g = this.state[6], h = this.state[7];
  for (var round = 0; round < 64; round++) {
    var s1e = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
    var choose = (e & f) ^ (~e & g);
    var t1 = (h + s1e + choose + SHA256_K[round] + w[round]) >>> 0;
    var s0a = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
    var majority = (a & b) ^ (a & c) ^ (b & c);
    var t2 = (s0a + majority) >>> 0;
    h = g; g = f; f = e; e = (d + t1) >>> 0;
    d = c; c = b; b = a; a = (t1 + t2) >>> 0;
  }
  this.state[0] = (this.state[0] + a) >>> 0;
  this.state[1] = (this.state[1] + b) >>> 0;
  this.state[2] = (this.state[2] + c) >>> 0;
  this.state[3] = (this.state[3] + d) >>> 0;
  this.state[4] = (this.state[4] + e) >>> 0;
  this.state[5] = (this.state[5] + f) >>> 0;
  this.state[6] = (this.state[6] + g) >>> 0;
  this.state[7] = (this.state[7] + h) >>> 0;
};

function readU32BE(buf, offset) {
  return ((buf[offset] << 24) | (buf[offset + 1] << 16) | (buf[offset + 2] << 8) | buf[offset + 3]) >>> 0;
}

function writeU32BE(buf, offset, value) {
  buf[offset] = (value >>> 24) & 255;
  buf[offset + 1] = (value >>> 16) & 255;
  buf[offset + 2] = (value >>> 8) & 255;
  buf[offset + 3] = value & 255;
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
