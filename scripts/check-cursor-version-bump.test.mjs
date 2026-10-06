// Tests for scripts/check-cursor-version-bump.mjs. Each case builds a throwaway git repository in a temp
// dir (no network, no signing, nothing outside the temp dir).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkVersionBump, compareSemver } from './check-cursor-version-bump.mjs';

const SCRIPT = resolve(dirname(fileURLToPath(import.meta.url)), 'check-cursor-version-bump.mjs');
const PLUGIN = 'cursor/replylayer/.cursor-plugin/plugin.json';
const MARKET = '.cursor-plugin/marketplace.json';

function git(dir, ...args) {
  const res = spawnSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', '-C', dir, ...args], { encoding: 'utf8' });
  assert.equal(res.status, 0, `git ${args.join(' ')}: ${res.stderr}`);
  return res.stdout.trim();
}

function put(dir, rel, body) {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), typeof body === 'string' ? body : `${JSON.stringify(body, null, 2)}\n`);
}

const pkg = (plugin, market = plugin) => (dir) => {
  put(dir, PLUGIN, { name: 'replylayer', version: plugin });
  put(dir, MARKET, { name: 'replylayer', metadata: { version: market }, plugins: [] });
};

// Builds a repo with a base commit (`base` writes files) and a head commit (`head` changes them); returns the dir.
function repo(base, head) {
  const dir = mkdtempSync(join(tmpdir(), 'rl-bump-'));
  git(dir, 'init', '-q');
  git(dir, 'config', 'commit.gpgsign', 'false');
  put(dir, 'README.md', 'base\n');
  base(dir);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'base');
  git(dir, 'branch', '-M', 'main');
  git(dir, 'switch', '-q', '-c', 'change');
  head(dir);
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'head', '--allow-empty');
  return dir;
}

function run(base, head, expect) {
  const dir = repo(base, head);
  try {
    expect(checkVersionBump(dir, 'main'), dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const touchPackage = (dir) => put(dir, 'cursor/replylayer/README.md', 'changed\n');

test('compareSemver orders numerically, not as strings', () => {
  assert.ok(compareSemver('0.10.0', '0.9.9') > 0);
  assert.ok(compareSemver('1.0.0', '0.99.99') > 0);
  assert.equal(compareSemver('0.1.0', '0.1.0'), 0);
  assert.ok(compareSemver('0.1.0', '0.1.1') < 0);
});

test('a change outside the Cursor package passes without a version bump', () => {
  run(pkg('0.1.0'), (d) => put(d, 'claude/replylayer/README.md', 'x\n'), ({ errors, touched }) => {
    assert.equal(touched, false);
    assert.deepEqual(errors, []);
  });
});

test('a package change with a raised version and a matching marketplace passes', () => {
  run(pkg('0.1.0'), (d) => { touchPackage(d); pkg('0.1.1')(d); }, ({ errors, touched }) => {
    assert.equal(touched, true);
    assert.deepEqual(errors, []);
  });
  run(pkg('0.9.9'), (d) => { touchPackage(d); pkg('0.10.0')(d); }, ({ errors }) => assert.deepEqual(errors, []));
});

test('a package change with the same version fails', () => {
  run(pkg('0.1.0'), touchPackage, ({ errors }) => {
    assert.equal(errors.length, 1);
    assert.match(errors[0], /version 0\.1\.0 must be higher than the base's 0\.1\.0/);
  });
});

test('a lowered version fails', () => {
  run(pkg('0.2.0'), (d) => { touchPackage(d); pkg('0.1.5')(d); }, ({ errors }) => {
    assert.match(errors.join('\n'), /version 0\.1\.5 must be higher than the base's 0\.2\.0/);
  });
});

test('a marketplace change alone needs a bump too', () => {
  run(pkg('0.1.0'), (d) => put(d, MARKET, { name: 'replylayer', metadata: { version: '0.1.0', description: 'x' }, plugins: [] }), ({ errors, touched }) => {
    assert.equal(touched, true);
    assert.match(errors.join('\n'), /must be higher than the base's 0\.1\.0/);
  });
});

test('metadata.version must equal plugin.json version', () => {
  run(pkg('0.1.0'), (d) => { touchPackage(d); pkg('0.2.0', '0.1.0')(d); }, ({ errors }) => {
    assert.equal(errors.length, 1);
    assert.match(errors[0], /metadata\.version "0\.1\.0" must equal plugin\.json version 0\.2\.0/);
  });
});

test('a base without the package passes, but the marketplace must still match', () => {
  run(() => {}, (d) => pkg('0.1.0')(d), ({ errors, touched }) => {
    assert.equal(touched, true);
    assert.deepEqual(errors, []);
  });
  run(() => {}, (d) => pkg('0.1.0', '0.0.9')(d), ({ errors }) => {
    assert.match(errors.join('\n'), /metadata\.version "0\.0\.9" must equal plugin\.json version 0\.1\.0/);
  });
});

test('a non-semver or missing version fails', () => {
  run(pkg('0.1.0'), (d) => { touchPackage(d); pkg('v0.2')(d); }, ({ errors }) => assert.match(errors.join('\n'), /version must be MAJOR\.MINOR\.PATCH/));
  run(pkg('0.1.0'), (d) => { rmSync(join(d, PLUGIN)); }, ({ errors }) => assert.match(errors.join('\n'), /is missing at HEAD but the change touches the package/));
});

test('an unknown base ref is an error, not a pass', () => {
  const dir = repo(pkg('0.1.0'), touchPackage);
  try {
    const { errors } = checkVersionBump(dir, 'no-such-ref');
    assert.match(errors.join('\n'), /cannot diff no-such-ref\.\.\.HEAD/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the CLI exits 1 on a missing bump, 0 on a bump, and 2 without a base', () => {
  const bad = repo(pkg('0.1.0'), touchPackage);
  const good = repo(pkg('0.1.0'), (d) => { touchPackage(d); pkg('0.1.1')(d); });
  try {
    const failRun = spawnSync(process.execPath, [SCRIPT, 'main', '--root', bad], { encoding: 'utf8' });
    assert.equal(failRun.status, 1);
    assert.match(failRun.stderr, /FAIL .*must be higher than the base's 0\.1\.0/);
    const okRun = spawnSync(process.execPath, [SCRIPT, 'main', '--root', good], { encoding: 'utf8' });
    assert.equal(okRun.status, 0, okRun.stderr);
    assert.equal(spawnSync(process.execPath, [SCRIPT], { encoding: 'utf8', cwd: good }).status, 2);
  } finally {
    rmSync(bad, { recursive: true, force: true });
    rmSync(good, { recursive: true, force: true });
  }
});

test('a depth-1 clone fails closed: the base is not reachable, so the check errors instead of passing', () => {
  const dir = repo(pkg('0.1.0'), (d) => { touchPackage(d); pkg('0.1.1')(d); });
  const shallow = mkdtempSync(join(tmpdir(), 'rl-bump-shallow-'));
  try {
    const baseSha = git(dir, 'rev-parse', 'main');
    const clone = spawnSync('git', ['clone', '-q', '--depth', '1', `file://${dir}`, join(shallow, 'c')], { encoding: 'utf8' });
    assert.equal(clone.status, 0, clone.stderr);
    const res = spawnSync(process.execPath, [SCRIPT, baseSha, '--root', join(shallow, 'c')], { encoding: 'utf8' });
    assert.notEqual(res.status, 0);
    assert.equal(res.status, 1);
    assert.match(res.stderr, /FAIL cannot diff .*\.\.\.HEAD/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
    rmSync(shallow, { recursive: true, force: true });
  }
});

test('moving a file out of the package counts as touching it (no rename detection)', () => {
  run((d) => { pkg('0.1.0')(d); put(d, 'cursor/replylayer/README.md', 'readme body that is long enough to be detected as a rename\n'.repeat(20)); }, (d) => {
    mkdirSync(join(d, 'docs'), { recursive: true });
    git(d, 'mv', 'cursor/replylayer/README.md', 'docs/README.md');
  }, ({ errors, touched }) => {
    assert.equal(touched, true);
    assert.match(errors.join('\n'), /must be higher than the base's 0\.1\.0/);
  });
});

test('a non-ASCII file name in the package counts as touching it', () => {
  run(pkg('0.1.0'), (d) => put(d, 'cursor/replylayer/caf\u00e9.md', 'x\n'), ({ errors, touched }) => {
    assert.equal(touched, true);
    assert.match(errors.join('\n'), /must be higher than the base's 0\.1\.0/);
  });
  run(pkg('0.1.0'), (d) => { put(d, 'cursor/replylayer/caf\u00e9.md', 'x\n'); pkg('0.1.1')(d); }, ({ errors }) => assert.deepEqual(errors, []));
});

test('a non-semver base version fails closed', () => {
  run(pkg('9.9.9-rc'), (d) => { touchPackage(d); pkg('0.0.1')(d); }, ({ errors }) => {
    assert.equal(errors.length, 1);
    assert.match(errors[0], /at main: version "9\.9\.9-rc" is not MAJOR\.MINOR\.PATCH, so it cannot be compared/);
  });
  run((d) => put(d, PLUGIN, { name: 'replylayer' }), (d) => { touchPackage(d); pkg('0.0.1')(d); }, ({ errors }) => {
    assert.match(errors.join('\n'), /is not MAJOR\.MINOR\.PATCH, so it cannot be compared/);
  });
});

test('an unparseable base plugin.json fails closed', () => {
  run((d) => { put(d, PLUGIN, '{ not json'); put(d, MARKET, { name: 'replylayer', metadata: { version: '0.1.0' }, plugins: [] }); }, (d) => { touchPackage(d); pkg('0.1.0')(d); }, ({ errors }) => {
    assert.match(errors.join('\n'), /cursor\/replylayer\/\.cursor-plugin\/plugin\.json at main: /);
  });
});
