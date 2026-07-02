// Local wrapper for apriltag-js-standalone. It removes the demo's remote
// Comlink dependency and exposes a small synchronous detector API for workers.
(function(global) {
  function FastGridAprilTag3() {
    this._opt = {
      quad_decimate: 2.0,
      quad_sigma: 0.0,
      nthreads: 1,
      refine_edges: 1,
      max_detections: 8,
      return_pose: 0,
      return_solutions: 0
    };
    this.ready = this._initModule();
  }

  FastGridAprilTag3.prototype._initModule = function() {
    var detector = this;
    return AprilTagWasm({
      locateFile: function(path) {
        return new URL('../vendor/apriltag3/' + path, global.location.href).href;
      }
    }).then(function(Module) {
      detector._Module = Module;
      detector._init = Module.cwrap('atagjs_init', 'number', []);
      detector._destroy = Module.cwrap('atagjs_destroy', 'number', []);
      detector._set_detector_options = Module.cwrap('atagjs_set_detector_options', 'number', ['number', 'number', 'number', 'number', 'number', 'number', 'number']);
      detector._set_img_buffer = Module.cwrap('atagjs_set_img_buffer', 'number', ['number', 'number', 'number']);
      detector._detect = Module.cwrap('atagjs_detect', 'number', []);
      detector._init();
      detector._applyOptions();
      return detector;
    });
  };

  FastGridAprilTag3.prototype._applyOptions = function() {
    this._set_detector_options(
      this._opt.quad_decimate,
      this._opt.quad_sigma,
      this._opt.nthreads,
      this._opt.refine_edges,
      this._opt.max_detections,
      this._opt.return_pose,
      this._opt.return_solutions
    );
  };

  FastGridAprilTag3.prototype.detect = function(grayscaleImg, imgWidth, imgHeight) {
    var imgBuffer = this._set_img_buffer(imgWidth, imgHeight, imgWidth);
    if (imgWidth * imgHeight < grayscaleImg.length) return [];
    this._Module.HEAPU8.set(grayscaleImg, imgBuffer);
    var strJsonPtr = this._detect();
    var strJsonLen = this._Module.getValue(strJsonPtr, 'i32');
    if (!strJsonLen) return [];
    var strJsonStrPtr = this._Module.getValue(strJsonPtr + 4, 'i32');
    var strJsonView = new Uint8Array(this._Module.HEAP8.buffer, strJsonStrPtr, strJsonLen);
    var detectionsJson = '';
    for (var i = 0; i < strJsonLen; i++) detectionsJson += String.fromCharCode(strJsonView[i]);
    return JSON.parse(detectionsJson);
  };

  FastGridAprilTag3.prototype.destroy = function() {
    if (this._destroy) this._destroy();
  };

  global.FastGridAprilTag3 = FastGridAprilTag3;
})(self);
