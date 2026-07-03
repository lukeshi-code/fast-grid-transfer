var https = require('https');
var http = require('http');
var fs = require('fs');
var path = require('path');
var os = require('os');
var crypto = require('crypto');
var childProcess = require('child_process');

var PORT = Number(process.env.PORT || 3000);
var DIR = __dirname;

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

function handleDeltaDefaults(req, res) {
  sendJson(res, 200, {
    repo: DIR,
    out: path.join(DIR, 'transfer-delta'),
    tar: path.join(DIR, 'transfer-delta.tar')
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
        sendJson(res, 500, {
          ok: false,
          error: result.stderr || result.stdout || 'Delta package generation failed',
          stdout: result.stdout || '',
          stderr: result.stderr || ''
        });
        return;
      }

      var manifestPath = path.join(path.resolve(out), 'manifest.json');
      var manifest = fs.existsSync(manifestPath) ? JSON.parse(fs.readFileSync(manifestPath, 'utf8')) : null;
      sendJson(res, 200, {
        ok: true,
        out: path.resolve(out),
        tar: tar ? path.resolve(tar) : null,
        manifest: manifest,
        stdout: result.stdout || '',
        stderr: result.stderr || ''
      });
    } catch (error) {
      sendJson(res, 400, { ok: false, error: error.message });
    }
  });
}

function handler(req, res) {
  var urlPath = req.url.split('?')[0];
  if (req.method === 'GET' && urlPath === '/api/delta/defaults') {
    handleDeltaDefaults(req, res);
    return;
  }
  if (req.method === 'POST' && urlPath === '/api/delta/collect') {
    handleDeltaCollect(req, res);
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
  });
}

if (require.main === module) startHTTPS();

if (typeof module !== 'undefined') module.exports = { resolveSafePath: resolveSafePath };
