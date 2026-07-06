var https = require('https');
var http = require('http');
var fs = require('fs');
var path = require('path');
var os = require('os');
var crypto = require('crypto');
var childProcess = require('child_process');

var PORT = Number(process.env.PORT || 3000);
var DIR = __dirname;
var deltaArchives = {};

function resolveSafePath(baseDir, urlPath) {
  try { urlPath = decodeURIComponent(urlPath); } catch (e) {}
  try { urlPath = decodeURIComponent(urlPath); } catch (e) {}
  if (urlPath.endsWith('/')) urlPath += 'index.html';
  if (urlPath === '/') urlPath = '/index.html';
  if (/[\\]/.test(urlPath) || /\.\./.test(urlPath)) return null;
  var filePath = path.resolve(baseDir, '.' + urlPath);
  if (!filePath.startsWith(baseDir + path.sep) && filePath !== baseDir) return null;
  return filePath;
}

var mimeTypes = {
  '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.map': 'application/json',
  '.wasm': 'application/wasm'
};

function sendJson(res, status, body) {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store, max-age=0',
    'Pragma': 'no-cache'
  });
  res.end(JSON.stringify(body));
}

function readJsonBody(req, done) {
  var chunks = [];
  var size = 0;
  req.on('data', function(chunk) {
    size += chunk.length;
    if (size > 1024 * 1024) {
      req.destroy();
      done(new Error('Request body too large'));
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', function() {
    try {
      done(null, chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {});
    } catch (err) {
      done(new Error('Invalid JSON body'));
    }
  });
  req.on('error', done);
}

function readRawBody(req, maxBytes, done) {
  var chunks = [];
  var size = 0;
  req.on('data', function(chunk) {
    size += chunk.length;
    if (size > maxBytes) {
      req.destroy();
      done(new Error('Request body too large'));
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', function() {
    done(null, Buffer.concat(chunks));
  });
  req.on('error', done);
}

function handleDeltaDefaults(req, res) {
  sendJson(res, 200, {
    repo: DIR,
    out: path.join(DIR, 'transfer-delta'),
    tar: path.join(DIR, 'transfer-delta.tar')
  });
}

function handleHealth(req, res) {
  sendJson(res, 200, {
    ok: true,
    app: 'fast-grid-transfer',
    features: {
      deltaCollect: true,
      deltaArchive: true,
      deltaApply: true,
      lockTools: !!findHandleExe()
    },
    tools: {
      handle: findHandleExe()
    }
  });
}

function handleDeltaCollect(req, res) {
  readJsonBody(req, function(err, body) {
    if (err) {
      sendJson(res, 400, { ok: false, error: err.message });
      return;
    }
    try {
      var repo = String(body.repo || '').trim();
      if (!repo) throw new Error('Repository path is required');
      var out = String(body.out || path.join(DIR, 'transfer-delta')).trim();
      var tar = body.tar === false ? false : String(body.tar || path.join(DIR, 'transfer-delta.tar')).trim();
      var vcs = String(body.vcs || 'auto').trim();
      var args = [path.join(DIR, 'scripts', 'collect-changes.js'), '--repo', repo, '--vcs', vcs, '--out', out];

      if (vcs === 'svn') {
        if (!body.from) throw new Error('SVN start revision is required');
        args.push('--from', String(body.from).trim());
        args.push('--to', String(body.to || 'HEAD').trim());
      } else {
        if (!body.base) throw new Error('Git base ref is required');
        args.push('--base', String(body.base).trim());
        args.push('--head', String(body.head || 'HEAD').trim());
        if (body.includeWorking) args.push('--include-working');
      }
      if (tar) args.push('--tar', tar);

      var result = childProcess.spawnSync(process.execPath, args, {
        cwd: DIR,
        encoding: 'utf8',
        windowsHide: true,
        maxBuffer: 20 * 1024 * 1024
      });
      if (result.error) throw result.error;
      if (result.status !== 0) {
        var errorText = (result.stderr || result.stdout || 'Delta package generation failed').trim();
        sendJson(res, 500, {
          ok: false,
          error: errorText.split(/\r?\n/).find(Boolean) || 'Delta package generation failed',
          stdout: result.stdout || '',
          stderr: result.stderr || ''
        });
        return;
      }

      var manifestPath = path.join(path.resolve(out), 'manifest.json');
      var manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
      var archiveToken = null;
      var archiveUrl = null;
      var encoderUrl = null;
      if (tar && fs.existsSync(path.resolve(tar))) {
        archiveToken = crypto.randomBytes(16).toString('hex');
        deltaArchives[archiveToken] = {
          path: path.resolve(tar),
          name: path.basename(path.resolve(tar)),
          createdAt: Date.now()
        };
        archiveUrl = '/api/delta/archive/' + archiveToken;
        encoderUrl = '/encoder/?deltaToken=' + encodeURIComponent(archiveToken) + '&name=' + encodeURIComponent(deltaArchives[archiveToken].name) + '&autoplay=1';
      }
      sendJson(res, 200, {
        ok: true,
        out: path.resolve(out),
        tar: tar ? path.resolve(tar) : null,
        archiveUrl: archiveUrl,
        encoderUrl: encoderUrl,
        manifest: manifest,
        stdout: result.stdout || '',
        stderr: result.stderr || ''
      });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
  });
}

function handleDeltaArchive(req, res, token) {
  var archive = deltaArchives[token];
  if (!archive || !fs.existsSync(archive.path)) {
    sendJson(res, 404, { ok: false, error: 'Delta archive is no longer available. Build the package again.' });
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'application/x-tar',
    'Content-Length': fs.statSync(archive.path).size,
    'Content-Disposition': 'attachment; filename="' + archive.name.replace(/"/g, '') + '"',
    'Cache-Control': 'no-store, max-age=0',
    'Pragma': 'no-cache'
  });
  fs.createReadStream(archive.path).pipe(res);
}

function handleDeltaApply(req, res) {
  var parsed = new URL(req.url, 'http://localhost');
  var targetRoot = String(parsed.searchParams.get('targetRoot') || '').trim();
  var applyDeletes = parsed.searchParams.get('applyDeletes') === '1';
  if (!targetRoot) {
    sendJson(res, 400, { ok: false, error: 'Target root is required.' });
    return;
  }
  targetRoot = path.resolve(targetRoot);
  if (!fs.existsSync(targetRoot) || !fs.statSync(targetRoot).isDirectory()) {
    sendJson(res, 400, { ok: false, error: 'Target root does not exist or is not a directory: ' + targetRoot });
    return;
  }

  readRawBody(req, 1024 * 1024 * 1024, function(err, body) {
    if (err) {
      sendJson(res, 400, { ok: false, error: err.message });
      return;
    }
    try {
      prepareTargetForApply(targetRoot);
      var result = applyDeltaTar(body, targetRoot, applyDeletes);
      sendJson(res, 200, { ok: true, targetRoot: targetRoot, result: result });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
  });
}

function handleLockCheck(req, res) {
  var parsed = new URL(req.url, 'http://localhost');
  var targetRoot = String(parsed.searchParams.get('targetRoot') || '').trim();
  if (!targetRoot) {
    sendJson(res, 400, { ok: false, error: 'Target root is required.' });
    return;
  }
  try {
    var locks = findFileLocks(targetRoot);
    sendJson(res, 200, { ok: true, targetRoot: path.resolve(targetRoot), handleExe: findHandleExe(), locks: locks });
  } catch (error) {
    sendJson(res, 400, { ok: false, error: error.message, handleExe: findHandleExe() });
  }
}

function handleLockClose(req, res) {
  readJsonBody(req, function(err, body) {
    if (err) {
      sendJson(res, 400, { ok: false, error: err.message });
      return;
    }
    try {
      var targetRoot = String(body.targetRoot || '').trim();
      var locks = Array.isArray(body.locks) && body.locks.length ? body.locks : findFileLocks(targetRoot);
      var closed = [];
      var skipped = [];
      var failed = [];
      var seen = {};
      locks.forEach(function(lock) {
        var pid = Number(lock.pid);
        if (!pid || seen[pid]) return;
        seen[pid] = true;
        if (!canKillPid(pid, lock.process)) {
          skipped.push({ pid: pid, process: lock.process, reason: 'protected process' });
          return;
        }
        var result = childProcess.spawnSync('taskkill', ['/F', '/PID', String(pid)], { encoding: 'utf8', windowsHide: true });
        if (result.status === 0) closed.push({ pid: pid, process: lock.process });
        else failed.push({ pid: pid, process: lock.process, error: (result.stderr || result.stdout || 'taskkill failed').trim() });
      });
      sendJson(res, 200, { ok: true, closed: closed, skipped: skipped, failed: failed });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
  });
}

function findHandleExe() {
  var candidates = [
    path.join(DIR, 'tools', 'handle.exe'),
    'C:\\Tools\\handle.exe',
    'C:\\Sysinternals\\handle.exe'
  ];
  for (var i = 0; i < candidates.length; i++) {
    if (fs.existsSync(candidates[i])) return candidates[i];
  }
  var where = childProcess.spawnSync('where', ['handle.exe'], { encoding: 'utf8', windowsHide: true });
  if (where.status === 0) {
    return where.stdout.split(/\r?\n/).map(function(line) { return line.trim(); }).find(Boolean) || null;
  }
  return null;
}

function findFileLocks(targetRoot) {
  targetRoot = path.resolve(targetRoot);
  if (!fs.existsSync(targetRoot) || !fs.statSync(targetRoot).isDirectory()) {
    throw new Error('Target root does not exist or is not a directory: ' + targetRoot);
  }
  var handleExe = findHandleExe();
  if (!handleExe) {
    throw new Error('handle.exe was not found. Run tools\\install-handle.bat, then restart run-fast-grid.bat.');
  }
  var result = childProcess.spawnSync(handleExe, ['-accepteula', '-nobanner', targetRoot], {
    cwd: DIR,
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 20 * 1024 * 1024,
    timeout: 8000
  });
  var output = (result.stdout || '') + '\n' + (result.stderr || '');
  if (result.error && result.error.code === 'ETIMEDOUT') {
    throw new Error('Handle scan timed out. Close IDE/build tools or apply directly after cleanup.');
  }
  if (result.signal === 'SIGTERM') {
    throw new Error('Handle scan timed out. Close IDE/build tools or apply directly after cleanup.');
  }
  if (result.error) throw result.error;
  return parseHandleOutput(output).filter(function(lock) {
    return lock.path && lock.path.toLowerCase().indexOf(targetRoot.toLowerCase()) === 0;
  });
}

function parseHandleOutput(output) {
  var locks = [];
  output.split(/\r?\n/).forEach(function(line) {
    var match = line.match(/^\s*(.+?)\s+pid:\s*(\d+)\s+type:\s*(\S+)\s+[0-9A-Fa-f]+:\s*(.+)$/);
    if (!match) return;
    locks.push({
      process: match[1].trim(),
      pid: Number(match[2]),
      type: match[3],
      path: match[4].trim()
    });
  });
  return locks;
}

function canKillPid(pid, processName) {
  if (pid === process.pid || pid <= 4) return false;
  var name = String(processName || '').toLowerCase();
  return ['system', 'registry', 'idle', 'svchost.exe', 'explorer.exe'].indexOf(name) === -1;
}

function prepareTargetForApply(targetRoot) {
  runSvnCleanupIfAvailable(targetRoot);
  clearReadonlyAttributes(targetRoot);
}

function runSvnCleanupIfAvailable(targetRoot) {
  if (!fs.existsSync(path.join(targetRoot, '.svn'))) return;
  var svn = findSvnExe();
  if (!svn) return;
  childProcess.spawnSync(svn, ['cleanup', targetRoot], {
    cwd: targetRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000
  });
}

function clearReadonlyAttributes(targetRoot) {
  if (process.platform !== 'win32') return;
  childProcess.spawnSync('attrib', ['-R', path.join(targetRoot, '*'), '/S'], {
    cwd: targetRoot,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 30000
  });
}

function findSvnExe() {
  var candidates = [
    'C:\\Program Files\\TortoiseSVN\\bin\\svn.exe',
    'C:\\Program Files (x86)\\TortoiseSVN\\bin\\svn.exe',
    'C:\\Program Files\\SlikSvn\\bin\\svn.exe',
    'C:\\Program Files (x86)\\SlikSvn\\bin\\svn.exe'
  ];
  for (var i = 0; i < candidates.length; i++) {
    if (fs.existsSync(candidates[i])) return candidates[i];
  }
  var where = childProcess.spawnSync('where', ['svn.exe'], { encoding: 'utf8', windowsHide: true });
  if (where.status === 0) {
    return where.stdout.split(/\r?\n/).map(function(line) { return line.trim(); }).find(Boolean) || null;
  }
  return null;
}

function applyDeltaTar(buffer, targetRoot, applyDeletes) {
  var entries = parseTar(buffer);
  var copied = [];
  var deleted = [];
  var skipped = [];
  var failed = [];
  var deletedTxt = null;

  entries.forEach(function(entry) {
    var normalized = normalizeTarPath(entry.name);
    if (!normalized) return;
    if (normalized === 'deleted.txt') {
      deletedTxt = entry.data.toString('utf8');
      return;
    }
    if (entry.type !== 'file') return;
    if (normalized.indexOf('files/') !== 0) return;

    var rel = normalized.slice('files/'.length);
    if (!rel) return;
    try {
      var dest = safeTargetPath(targetRoot, rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      makeWritableIfExists(dest);
      fs.writeFileSync(dest, entry.data);
      copied.push(rel);
    } catch (error) {
      failed.push({ path: rel, error: error.message });
    }
  });

  if (applyDeletes && deletedTxt) {
    deletedTxt.split(/\r?\n/).map(function(line) { return line.trim(); }).filter(Boolean).forEach(function(rel) {
      try {
        var target = safeTargetPath(targetRoot, rel);
        if (fs.existsSync(target) && fs.statSync(target).isFile()) {
          makeWritableIfExists(target);
          fs.unlinkSync(target);
          deleted.push(rel);
        } else {
          skipped.push({ path: rel, reason: 'not found' });
        }
      } catch (error) {
        failed.push({ path: rel, error: error.message });
      }
    });
  }

  return {
    copied: copied,
    deleted: deleted,
    skipped: skipped,
    failed: failed,
    counts: {
      copied: copied.length,
      deleted: deleted.length,
      skipped: skipped.length,
      failed: failed.length
    }
  };
}

function makeWritableIfExists(filePath) {
  if (!fs.existsSync(filePath)) return;
  try {
    var stat = fs.statSync(filePath);
    fs.chmodSync(filePath, stat.mode | 0o200);
  } catch (_) {}
}

function parseTar(buffer) {
  var entries = [];
  var offset = 0;
  var longName = null;
  while (offset + 512 <= buffer.length) {
    var header = buffer.slice(offset, offset + 512);
    if (isZeroBlock(header)) break;
    var name = readTarString(header, 0, 100);
    var size = parseInt(readTarString(header, 124, 12).trim() || '0', 8) || 0;
    var typeFlag = readTarString(header, 156, 1) || '0';
    var prefix = readTarString(header, 345, 155);
    if (prefix) name = prefix + '/' + name;
    offset += 512;
    var data = buffer.slice(offset, offset + size);
    var padded = Math.ceil(size / 512) * 512;
    offset += padded;

    if (typeFlag === 'L') {
      longName = data.toString('utf8').replace(/\0.*$/, '');
      continue;
    }
    if (longName) {
      name = longName;
      longName = null;
    }
    entries.push({
      name: name,
      type: typeFlag === '0' || typeFlag === '\0' || typeFlag === '' ? 'file' : (typeFlag === '5' ? 'dir' : 'other'),
      data: data
    });
  }
  return entries;
}

function readTarString(buffer, start, length) {
  return buffer.slice(start, start + length).toString('utf8').replace(/\0.*$/, '').trim();
}

function isZeroBlock(buffer) {
  for (var i = 0; i < buffer.length; i++) {
    if (buffer[i] !== 0) return false;
  }
  return true;
}

function normalizeTarPath(value) {
  var normalized = String(value || '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/^\/+/, '');
  if (!normalized || normalized.indexOf('\0') !== -1) return '';
  if (normalized.split('/').indexOf('..') !== -1) throw new Error('Unsafe tar path: ' + value);
  return normalized;
}

function safeTargetPath(root, rel) {
  var normalized = normalizeTarPath(rel);
  if (!normalized) throw new Error('Empty target path');
  var target = path.resolve(root, normalized);
  var relative = path.relative(root, target);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Path escapes target root: ' + rel);
  }
  return target;
}

function handler(req, res) {
  var urlPath = req.url.split('?')[0];
  if (req.method === 'GET' && urlPath === '/api/health') {
    handleHealth(req, res);
    return;
  }
  if (req.method === 'GET' && urlPath === '/api/delta/defaults') {
    handleDeltaDefaults(req, res);
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/delta/collect') {
    handleDeltaCollect(req, res);
    return;
  }
  if (req.method === 'GET' && urlPath.indexOf('/api/delta/archive/') === 0) {
    handleDeltaArchive(req, res, decodeURIComponent(urlPath.slice('/api/delta/archive/'.length)));
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/delta/apply') {
    handleDeltaApply(req, res);
    return;
  }
  if (req.method === 'GET' && urlPath === '/api/locks/check') {
    handleLockCheck(req, res);
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/locks/close') {
    handleLockClose(req, res);
    return;
  }
  var filePath = resolveSafePath(DIR, urlPath);
  if (!filePath) { res.writeHead(403); res.end(); return; }

  fs.readFile(filePath, function(err, data) {
    if (err) { res.writeHead(404); res.end('Not Found: ' + urlPath); return; }
    var ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': mimeTypes[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store, max-age=0',
      'Pragma': 'no-cache'
    });
    res.end(data);
  });
}

function getLocalIPs() {
  var ips = ['127.0.0.1', '0.0.0.0'];
  var nets = os.networkInterfaces();
  for (var name in nets) {
    for (var i = 0; i < nets[name].length; i++) {
      if (nets[name][i].family === 'IPv4' && !nets[name][i].internal) {
        ips.push(nets[name][i].address);
      }
    }
  }
  return ips;
}

function generateCert() {
  var ips = getLocalIPs();
  console.log('Generating self-signed cert for:', ips.join(', '));

  var { execSync } = require('child_process');
  var cnfPath = path.join(DIR, '_openssl.cnf');
  var certPath = path.join(DIR, 'cert.pem');
  var keyPath = path.join(DIR, 'key.pem');

  var san = ['DNS.1=localhost'];
  ips.forEach(function(ip, i) { san.push('IP.' + (i + 1) + '=' + ip); });

  var cnf = [
    '[req]', 'default_bits = 2048', 'prompt = no', 'default_md = sha256',
    'distinguished_name = dn', 'x509_extensions = v3_ca',
    '', '[dn]', 'CN = localhost',
    '', '[v3_ca]', 'subjectAltName = @alt_names',
    '', '[alt_names]'
  ].concat(san).join('\n');

  fs.writeFileSync(cnfPath, cnf);

    try {
      execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-keyout', keyPath, '-out', certPath, '-days', '365', '-nodes', '-config', cnfPath], { stdio: 'pipe' });
    fs.unlinkSync(cnfPath);
    console.log('Cert generated!');
    return true;
  } catch (e) {
    try { fs.unlinkSync(cnfPath); } catch (_) {}
    console.log('openssl failed, trying pure JS fallback...');
    return generateCertJS(certPath, keyPath, ips);
  }
}

function generateCertJS(certPath, keyPath, ips) {
  try {
    var pair = crypto.generateKeyPairSync('rsa', { modulusLength: 2048 });
    var privPem = pair.privateKey.export({ type: 'pkcs8', format: 'pem' });

    var attrs = [{ name: 'commonName', value: 'localhost' }];
    var sanExt = ips.map(function(ip) { return { type: 7, ip: ip }; });
    sanExt.push({ type: 2, value: 'localhost' });

    var spawnSync = require('child_process').spawnSync;

    var keyTmp = path.join(DIR, '_key.tmp');
    var csrTmp = path.join(DIR, '_csr.tmp');
    fs.writeFileSync(keyTmp, privPem);

    var { execFileSync } = require('child_process');
    var cnfPath = path.join(DIR, '_openssl.cnf');
    var san = ips.map(function(ip, i) { return 'IP.' + (i + 1) + '=' + ip; }).concat(['DNS.1=localhost']);
    var cnf = '[req]\ndefault_bits=2048\nprompt=no\ndefault_md=sha256\ndistinguished_name=dn\n[dn]\nCN=localhost\n[req_distinguished_name]\nCN=localhost\n';
    fs.writeFileSync(cnfPath, cnf);

    spawnSync('openssl', ['req', '-new', '-key', keyTmp, '-out', csrTmp, '-config', cnfPath], { stdio: 'pipe' });

    var extPath = path.join(DIR, '_ext.cnf');
    var extCnf = 'subjectAltName=' + san.join(',') + '\nbasicConstraints=CA:true\n';
    fs.writeFileSync(extPath, extCnf);

    spawnSync('openssl', ['x509', '-req', '-in', csrTmp, '-signkey', keyTmp, '-out', certPath, '-days', '365', '-sha256', '-extfile', extPath], { stdio: 'pipe' });

    fs.writeFileSync(keyPath, privPem);

    [keyTmp, csrTmp, cnfPath, extPath].forEach(function(f) { try { fs.unlinkSync(f); } catch (_) {} });

    if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
      console.log('Cert generated (fallback)!');
      return true;
    }
  } catch (e) {
    console.log('JS fallback failed:', e.message);
  }
  return false;
}

function startHTTPS() {
  var certPath = path.join(DIR, 'cert.pem');
  var keyPath = path.join(DIR, 'key.pem');

  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    if (!generateCert()) {
      console.log('Could not generate cert. Starting HTTP only (camera will not work on phone).');
      startHTTP();
      return;
    }
  }

  var options = { cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) };
  https.createServer(options, handler).listen(PORT, function() {
    console.log('HTTPS server running:');
    console.log('');
    console.log('  On this computer: https://localhost:' + PORT);
    console.log('');
    console.log('  On your phone (same WiFi):');
    var nets = os.networkInterfaces();
    for (var name in nets) {
      for (var i = 0; i < nets[name].length; i++) {
        var a = nets[name][i];
        if (a.family === 'IPv4' && !a.internal) {
          console.log('    https://' + a.address + ':' + PORT);
        }
      }
    }
    console.log('');
    console.log('  Your browser will show a security warning (self-signed cert).');
    console.log('  Click "Advanced" -> "Proceed" to continue.');
    console.log('');
    console.log('  Fast Grid Encoder: https://localhost:' + PORT + '/encoder/');
    console.log('  Fast Grid Decoder: https://localhost:' + PORT + '/decoder/');
    console.log('  Delta Packager:    https://localhost:' + PORT + '/delta/');
  });
}

function startHTTP() {
  http.createServer(handler).listen(PORT, function() {
    console.log('HTTP server running at http://localhost:' + PORT);
    console.log('');
    console.log('NOTE: Screen capture works best from localhost or HTTPS.');
    console.log('Fast Grid Encoder: http://localhost:' + PORT + '/encoder/');
    console.log('Fast Grid Decoder: http://localhost:' + PORT + '/decoder/');
    console.log('Delta Packager:    http://localhost:' + PORT + '/delta/');
    console.log('Delta Apply API:   enabled');
  });
}

if (require.main === module) startHTTPS();

if (typeof module !== 'undefined') module.exports = { resolveSafePath: resolveSafePath };
