(function(root) {
  'use strict';
  var protocol = {
    totalCols: 360,
    totalRows: 112,
    dataOffsetX: 18,
    dataOffsetY: 18,
    dataCols: 324,
    dataRows: 76,
    headerBytes: 56,
    protocolVersion: 12,
    expectedGrids: 2,
    tagBases: [0, 4],
    cacheMaxAge: 8
  };
  protocol.frameBytes2 = protocol.dataCols * protocol.dataRows * 2 / 8;
  protocol.frameBytes3 = protocol.dataCols * protocol.dataRows * 3 / 8;
  root.FastGridProtocol = Object.freeze(protocol);
})(typeof self !== 'undefined' ? self : globalThis);
