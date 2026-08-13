(function(root) {
  'use strict';
  var calibrationRows = [3, 108];
  var syncRows = [17, 94];
  var reservedRows = Object.create(null);
  calibrationRows.concat(syncRows).forEach(function(row) { reservedRows[row] = true; });
  var dataPhysicalRows = [];
  for (var row = 0; row < 112; row++) {
    if (!reservedRows[row]) dataPhysicalRows.push(row);
  }

  var protocol = {
    totalCols: 360,
    totalRows: 112,
    dataOffsetX: 18,
    dataOffsetY: 18,
    dataCols: 324,
    dataRows: dataPhysicalRows.length,
    dataPhysicalRows: Object.freeze(dataPhysicalRows),
    calibrationRows: Object.freeze(calibrationRows),
    syncRows: Object.freeze(syncRows),
    headerBytes: 56,
    protocolVersion: 14,
    expectedGrids: 2,
    tagBases: [0, 4],
    cacheMaxAge: 8
  };
  protocol.frameBytes2 = protocol.dataCols * protocol.dataRows * 2 / 8;
  protocol.frameBytes3 = protocol.dataCols * protocol.dataRows * 3 / 8;
  root.FastGridProtocol = Object.freeze(protocol);
})(typeof self !== 'undefined' ? self : globalThis);
