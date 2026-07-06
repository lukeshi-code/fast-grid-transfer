# Fast Grid Transfer

Experimental browser-based file transfer through a high-density colored screen grid.

The encoder renders binary frames as two parallel 100 x 100 visual grids with 64 x 64 data regions, four AprilTag 3 tag36h11 fiducial markers per grid, per-frame color calibration bars, and border sync lines. A Web Worker packages the selected file or folder stream, gzip-compresses it when useful, and uses the vendored `raptorq` WASM library to generate RFC6330 RaptorQ packets. The decoder captures the encoder tab/window with browser screen capture, detects the AprilTags through a vendored WASM detector, applies a homography to sample each data grid, validates each visual frame, feeds packets into the RaptorQ decoder, rebuilds the stream, verifies SHA-256, and downloads the file.

## Use

On Windows, double-click the only startup file:

```text
run-fast-grid.bat
```

It starts the local server and opens the home page. From there choose `Encoder`, `Decoder`, or `Delta Packager`.

Manual start:

```bash
node server.js
```

Open:

```text
http://localhost:3000/encoder/
http://localhost:3000/decoder/
```

Workflow:

1. Open the encoder and choose a file or folder.
2. Click `Fullscreen Grid` on the encoder if you want a larger visual signal. The canvas size is chosen automatically from the visible grid area.
3. Open the decoder and click `Start Screen Capture`.
4. In the browser picker, choose the encoder tab/window.
5. Wait for all frames to be captured; the decoder downloads the rebuilt file.

Folder transfers are streamed as a `.tar` archive so the encoder does not need to build a ZIP in memory first.

## Delta Code Directory Transfer

For large code directories, generate a small delta package from Git or SVN metadata and transfer only the changed files.

Open the visual packager:

```text
http://localhost:3000/delta/
```

Fill in the repository path, Git base or SVN revision range, then click `Build Delta Package`.

For code directory transfer, open `Delta Packager`, build the delta package, review the changed file list, and let it open the encoder automatically.

Git example:

```bash
npm run collect-changes -- --repo C:\work\project --base last-transfer --head HEAD --out transfer-delta --tar
```

SVN example:

```bash
npm run collect-changes -- --repo C:\work\project --vcs svn --from 1234 --to HEAD --out transfer-delta --tar
```

The output directory contains:

```text
transfer-delta/
  files/          changed files, preserving repository paths
  manifest.json  VCS metadata and changed/deleted/skipped entries
  files.txt      included file list
  deleted.txt    deleted file list
transfer-delta.tar
```

Send `transfer-delta.tar` with the encoder `Load File` button, or send the `transfer-delta` folder with `Load Folder`.

Recommended Git workflow:

1. After a successful full transfer, create or move a baseline tag in the source repository:

   ```bash
   git tag -f last-transfer HEAD
   ```

2. On the next transfer, collect only changes since that tag:

   ```bash
   npm run collect-changes -- --repo C:\work\project --base last-transfer --out transfer-delta --tar
   ```

3. After the delta has been received and applied, move the baseline tag again.

To create a portable zip for another Windows machine, run:

```text
package-windows.bat
```

The target machine still needs Node.js installed.

## Protocol

- Transport: browser screen capture of a colored pixel grid.
- Visual grid: 100 x 100 cells.
- Data region: 64 x 64 cells.
- Encoding: default 4 colors, 2 bits per data cell, 1024 raw bytes per visual frame/grid. High-speed mode uses 8 colors, 3 bits per data cell, 1536 raw bytes per visual frame/grid.
- Parallelism: the encoder displays two independent grids per playback tick; the decoder can accept both packets from one captured screen frame.
- Frame payload: raw frame bytes minus a 48-byte binary visual-frame header.
- FEC: RFC6330 RaptorQ via the vendored Apache-2.0 `raptorq` WASM package.
- Repair scheduling: RaptorQ repair packets are interleaved into the visual playback cycle instead of being sent only after all source packets.
- Completion: the decoder finishes as soon as the RaptorQ decoder reconstructs the full stream; it does not wait for every original source packet number.
- Compression: the encoder tries browser `CompressionStream('gzip')` and transmits gzip bytes only when they are smaller than the original stream; the decoder restores with `DecompressionStream`.
- Visual positioning: four AprilTag 3 tag36h11 markers are detected by vendored `apriltag-js-standalone` WASM assets; marker centers define a homography for perspective-correct sampling.
- Color calibration: each frame includes repeated 8-color calibration bars above and below the data region.
- Frame integrity: FNV-1a checksum per visual frame packet.
- File integrity: SHA-256 in the stream metadata, verified after reconstruction.
- Transfer mode: RaptorQ encoding runs in the encoder worker. The worker materializes the source stream in memory before RaptorQ encoding, so very large files need enough browser memory.
- Folder mode: files are packaged as a TAR archive generated by the encoder worker.
- Encode threading: `encoder/fast-grid-encoder-worker.js` prepares the stream and builds visual frames.
- Decode threading: frame detection and sampling run in `decoder/fast-grid-worker.js`; RaptorQ reconstruction runs in the decoder page.
- Packet map: green cells are source packets received directly, red cells are checksum-failed source packets that can be mapped to a packet index, and yellow cells are source packets recovered by RaptorQ.

This replaces the original animated-code mode. The main `encoder/` and `decoder/` pages no longer use the old QR pipeline.

## Files

```text
encoder/index.html              Fast Grid encoder
encoder/fast-grid-encoder-worker.js  Worker-based streaming frame generator
decoder/index.html              Fast Grid decoder UI
decoder/fast-grid-worker.js     Worker-based frame sampler/decoder
vendor/raptorq/                 Vendored RaptorQ WASM package
vendor/apriltag3/               Vendored AprilTag 3 WASM detector
server.js                       Local static server
```

## Notes

Best results come from sharing the encoder tab/window directly, keeping browser zoom at 100%, and making the grid large on screen. This is still an experimental visual channel; use it only in environments where you are authorized to transfer the data.

The decoder preview draws debug boxes while capturing: yellow is the current scan window, blue is the smoothed ROI, and green is the latest detected grid box with sync-line confidence.
