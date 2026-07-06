#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const cp = require('child_process');

const commandCache = {};
const windowsCommandCandidates = {
  svn: [
    'C:\\Program Files\\TortoiseSVN\\bin\\svn.exe',
    'C:\\Program Files (x86)\\TortoiseSVN\\bin\\svn.exe',
    'C:\\Program Files\\SlikSvn\\bin\\svn.exe',
    'C:\\Program Files (x86)\\SlikSvn\\bin\\svn.exe',
    'C:\\Program Files\\CollabNet\\Subversion Client\\svn.exe',
  ],
};

function usage() {
  console.log([
    'Usage:',
    '  node scripts/collect-changes.js --repo <path> --base <git-ref> [--head <git-ref>] [--out <dir>] [--tar]',
    '  node scripts/collect-changes.js --repo <path> --vcs svn --from <rev> [--to <rev|HEAD>] [--out <dir>] [--tar]',
    '',
    'Examples:',
    '  node scripts/collect-changes.js --repo C:\\work\\project --base last-transfer --out transfer-delta --tar',
    '  node scripts/collect-changes.js --repo C:\\work\\project --base origin/main --head HEAD --out transfer-delta',
    '  node scripts/collect-changes.js --repo C:\\work\\project --vcs svn --from 1234 --to HEAD --out transfer-delta --tar',
    '',
    'Options:',
    '  --repo <path>       Repository working copy. Defaults to current directory.',
    '  --vcs <auto|git|svn> Version-control type. Defaults to auto.',
    '  --base <ref>        Git base ref/commit/tag, exclusive.',
    '  --head <ref>        Git head ref/commit. Defaults to HEAD.',
    '  --from <rev>        SVN start revision, exclusive.',
    '  --to <rev|HEAD>     SVN end revision. Defaults to HEAD.',
    '  --out <dir>         Output directory. Defaults to ./transfer-delta.',
    '  --tar [path]        Also create a .tar archive. Path is optional.',
    '  --include-working   Git only: include uncommitted and staged changes.',
    '  --help              Show this help.',
  ].join('\n'));
}

function parseArgs(argv) {
  const args = {
    repo: process.cwd(),
    vcs: 'auto',
    head: 'HEAD',
    to: 'HEAD',
    out: 'transfer-delta',
    tar: false,
    includeWorking: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') args.help = true;
    else if (arg === '--include-working') args.includeWorking = true;
    else if (arg === '--tar') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args.tar = next;
        i++;
      } else {
        args.tar = true;
      }
    } else if (arg.startsWith('--')) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_, ch) => ch.toUpperCase());
      const value = argv[++i];
      if (!value || value.startsWith('--')) throw new Error(arg + ' requires a value');
      args[key] = value;
    } else {
      throw new Error('Unknown argument: ' + arg);
    }
  }
  return args;
}

function run(cmd, args, cwd) {
  const resolved = resolveCommand(cmd);
  const result = cp.spawnSync(resolved, args, { cwd, encoding: 'utf8', windowsHide: true });
  if (result.error) throw commandError(cmd, result.error);
  if (result.status !== 0) {
    throw new Error(cmd + ' ' + args.join(' ') + '\n' + (result.stderr || result.stdout));
  }
  return result.stdout;
}

function runNull(cmd, args, cwd) {
  const resolved = resolveCommand(cmd);
  const result = cp.spawnSync(resolved, args, { cwd, encoding: 'buffer', windowsHide: true });
  if (result.error) throw commandError(cmd, result.error);
  if (result.status !== 0) {
    throw new Error(cmd + ' ' + args.join(' ') + '\n' + Buffer.from(result.stderr || result.stdout).toString('utf8'));
  }
  return Buffer.from(result.stdout);
}

function resolveCommand(cmd) {
  if (commandCache[cmd]) return commandCache[cmd];
  if (process.platform === 'win32') {
    const where = cp.spawnSync('where', [cmd], { encoding: 'utf8', windowsHide: true });
    const first = where.status === 0 ? where.stdout.split(/\r?\n/).map(x => x.trim()).find(Boolean) : '';
    if (first) {
      commandCache[cmd] = first;
      return first;
    }
    const candidates = windowsCommandCandidates[cmd] || [];
    const found = candidates.find(candidate => fs.existsSync(candidate));
    if (found) {
      commandCache[cmd] = found;
      return found;
    }
  }
  commandCache[cmd] = cmd;
  return cmd;
}

function commandError(cmd, err) {
  if (err && err.code === 'ENOENT') {
    if (cmd === 'svn') {
      return new Error('SVN command line tool was not found. Install TortoiseSVN with command line tools, SlikSVN, or add svn.exe to PATH.');
    }
    if (cmd === 'git') {
      return new Error('Git command line tool was not found. Install Git for Windows or add git.exe to PATH.');
    }
  }
  return err;
}

function detectVcs(repo) {
  if (fs.existsSync(path.join(repo, '.git'))) return 'git';
  if (fs.existsSync(path.join(repo, '.svn'))) return 'svn';
  try {
    run('git', ['rev-parse', '--show-toplevel'], repo);
    return 'git';
  } catch (_) {}
  try {
    run('svn', ['info'], repo);
    return 'svn';
  } catch (_) {}
  throw new Error('Cannot detect Git or SVN working copy. Pass --vcs git or --vcs svn.');
}

function parseGitNameStatus(buffer) {
  const parts = buffer.toString('utf8').split('\0').filter(Boolean);
  const changes = [];
  for (let i = 0; i < parts.length; i++) {
    const status = parts[i];
    if (/^R|^C/.test(status)) {
      const oldPath = normalizeRel(parts[++i]);
      const newPath = normalizeRel(parts[++i]);
      changes.push({ status: status[0], path: newPath, oldPath });
    } else {
      changes.push({ status: status[0], path: normalizeRel(parts[++i]) });
    }
  }
  return changes;
}

function getGitChanges(repo, args) {
  if (!args.base) throw new Error('Git mode requires --base <ref>. Use your last transferred commit/tag as the base.');
  const range = args.base + '..' + (args.head || 'HEAD');
  const changes = parseGitNameStatus(runNull('git', ['diff', '--name-status', '-z', '--diff-filter=ACMRTD', range], repo));
  if (args.includeWorking) {
    changes.push(...parseGitNameStatus(runNull('git', ['diff', '--name-status', '-z', '--diff-filter=ACMRTD'], repo)));
    changes.push(...parseGitNameStatus(runNull('git', ['diff', '--cached', '--name-status', '-z', '--diff-filter=ACMRTD'], repo)));
  }
  const headCommit = run('git', ['rev-parse', args.head || 'HEAD'], repo).trim();
  return { vcs: 'git', base: args.base, head: args.head || 'HEAD', headCommit, changes };
}

function getSvnChanges(repo, args) {
  if (!args.from) throw new Error('SVN mode requires --from <revision>.');
  const to = args.to || 'HEAD';
  const xml = run('svn', ['diff', '--summarize', '--xml', '-r', args.from + ':' + to], repo);
  const changes = [];
  const itemRe = /<path\s+([^>]*)>([\s\S]*?)<\/path>/g;
  let match;
  while ((match = itemRe.exec(xml))) {
    const attrs = match[1];
    const rawPath = decodeXml(match[2].trim());
    const item = attrs.match(/item="([^"]+)"/);
    const status = item ? svnStatusToGitish(item[1]) : 'M';
    const absolutePath = path.isAbsolute(rawPath) ? rawPath : path.resolve(repo, rawPath);
    changes.push({ status, path: normalizeRel(path.relative(repo, absolutePath)) });
  }
  return { vcs: 'svn', from: args.from, to, changes };
}

function svnStatusToGitish(status) {
  if (status === 'added') return 'A';
  if (status === 'deleted') return 'D';
  if (status === 'modified') return 'M';
  if (status === 'replaced') return 'R';
  return 'M';
}

function decodeXml(text) {
  return text
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function normalizeRel(rel) {
  return rel.replace(/\\/g, '/').replace(/^\/+/, '');
}

function assertInside(root, target) {
  const rootPath = path.resolve(root);
  const targetPath = path.resolve(target);
  const rel = path.relative(rootPath, targetPath);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path escapes repository: ' + target);
}

function uniqueChanges(changes) {
  const byPath = new Map();
  for (const change of changes) byPath.set(change.path, change);
  return Array.from(byPath.values()).sort((a, b) => a.path.localeCompare(b.path));
}

function prepareOutput(repo, outDir, result) {
  const absOut = path.resolve(outDir);
  assertSafeOutputPath(repo, absOut);
  fs.rmSync(absOut, { recursive: true, force: true });
  fs.mkdirSync(absOut, { recursive: true });

  const filesDir = path.join(absOut, 'files');
  fs.mkdirSync(filesDir, { recursive: true });

  const changes = uniqueChanges(result.changes);
  const included = [];
  const skipped = [];
  const deleted = [];

  for (const change of changes) {
    const rel = normalizeRel(change.path);
    const src = path.resolve(repo, rel);
    assertInside(repo, src);
    if (change.status === 'D') {
      deleted.push(change);
      continue;
    }
    if (!fs.existsSync(src) || !fs.statSync(src).isFile()) {
      skipped.push({ ...change, reason: 'not a regular file' });
      continue;
    }
    const dest = path.join(filesDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    included.push(change);
  }

  const manifest = {
    generatedAt: new Date().toISOString(),
    repository: path.resolve(repo),
    vcs: result.vcs,
    base: result.base,
    head: result.head,
    headCommit: result.headCommit,
    from: result.from,
    to: result.to,
    counts: {
      changed: changes.length,
      included: included.length,
      deleted: deleted.length,
      skipped: skipped.length,
    },
    included,
    deleted,
    skipped,
  };

  fs.writeFileSync(path.join(absOut, 'manifest.json'), JSON.stringify(manifest, null, 2));
  fs.writeFileSync(path.join(absOut, 'files.txt'), included.map(x => x.path).join('\n') + (included.length ? '\n' : ''));
  fs.writeFileSync(path.join(absOut, 'deleted.txt'), deleted.map(x => x.path).join('\n') + (deleted.length ? '\n' : ''));
  return { absOut, manifest };
}

function assertSafeOutputPath(repo, outDir) {
  const root = path.parse(outDir).root;
  if (outDir === root) {
    throw new Error('Refusing to use a drive root as output folder: ' + outDir);
  }
  if (path.resolve(repo) === outDir) {
    throw new Error('Refusing to use the repository root as output folder: ' + outDir);
  }
  const name = path.basename(outDir).toLowerCase();
  if (!name || name === '.' || name === '..') {
    throw new Error('Unsafe output folder: ' + outDir);
  }
}

function createTar(outDir, tarOption) {
  const tarPath = tarOption === true ? outDir.replace(/[\\/]$/, '') + '.tar' : path.resolve(String(tarOption));
  fs.rmSync(tarPath, { force: true });
  run('tar', ['-cf', tarPath, '-C', outDir, '.'], process.cwd());
  return tarPath;
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    usage();
    return;
  }
  const repo = path.resolve(args.repo);
  const vcs = args.vcs === 'auto' ? detectVcs(repo) : args.vcs;
  if (vcs !== 'git' && vcs !== 'svn') throw new Error('--vcs must be auto, git, or svn');

  const result = vcs === 'git' ? getGitChanges(repo, args) : getSvnChanges(repo, args);
  const prepared = prepareOutput(repo, args.out, result);
  const tarPath = args.tar ? createTar(prepared.absOut, args.tar) : null;

  console.log('Delta package ready: ' + prepared.absOut);
  if (tarPath) console.log('Archive: ' + tarPath);
  console.log('Included files: ' + prepared.manifest.counts.included);
  console.log('Deleted files listed: ' + prepared.manifest.counts.deleted);
  console.log('Skipped entries: ' + prepared.manifest.counts.skipped);
}

try {
  main();
} catch (err) {
  console.error('collect-changes failed: ' + err.message);
  process.exit(1);
}
