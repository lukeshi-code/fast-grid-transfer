(function(root) {
  'use strict';
  var protocol = {
    totalCols: 236,
    totalRows: 86,
    dataOffsetX: 18,
    dataOffsetY: 18,
    dataCols: 200,
    dataRows: 50,
    headerBytes: 56,
    protocolVersion: 9,
    expectedGrids: 2,
    tagBases: [0, 4],
    cacheMaxAge: 8
  };
  protocol.frameBytes2 = protocol.dataCols * protocol.dataRows * 2 / 8;
  protocol.frameBytes3 = protocol.dataCols * protocol.dataRows * 3 / 8;
  root.FastGridProtocol = Object.freeze(protocol);
})(typeof self !== 'undefined' ? self : globalThis);
