// Version-bump rule for the Cursor package. Run on pull requests with the base commit:
//
//   node scripts/check-cursor-version-bump.mjs <base-ref> [--root <dir>]
//
// If the change from <base-ref> to HEAD touches cursor/replylayer/ or .cursor-plugin/, then plugin.json's
// `version` must be strictly higher than the base's (a base without the package passes), and the marketplace's
// metadata.version must equal it. Cursor serves what it last indexed, so a change nobody versioned cannot be
// told apart from the one before it. Plain Node >= 20 and git, no network.
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const PLUGIN_JSON = 'cursor/replylayer/.cursor-plugin/plugin.json';
const MARKETPLACE_JSON = '.cursor-plugin/marketplace.json';
const WATCHED = ['cursor/replylayer/', '.cursor-plugin/'];
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function git(root, args) {
  const res = spawnSync('git', ['-C', root, ...args], { encoding: 'utf8' });
  return { ok: res.status === 0, out: res.stdout ?? '', err: (res.stderr ?? '').trim() };
}

// Negative, zero or positive, like a comparator, for two MAJOR.MINOR.PATCH strings.
export function compareSemver(a, b) {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < 3; i += 1) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

function versionAt(root, ref, path) {
  const res = git(root, ['show', `${ref}:${path}`]);
  if (!res.ok) return { missing: true };
  try { return { value: JSON.parse(res.out).version }; } catch (err) { return { error: `${path} at ${ref}: ${err.message}` }; }
}

// Returns { errors, touched }. `errors` empty means the rule holds.
export function checkVersionBump(root, base) {
  const errors = [];
  // NUL-separated and without rename detection: a plain listing quotes non-ASCII names (so they would not match
  // the watched prefixes), and a rename would report only the new path, hiding a file moved out of the package.
  const diff = git(root, ['diff', '--name-only', '-z', '--no-renames', `${base}...HEAD`]);
  if (!diff.ok) return { errors: [`cannot diff ${base}...HEAD: ${diff.err}`], touched: false };
  const touched = diff.out.split('\0').some((f) => WATCHED.some((w) => f.startsWith(w)));
  if (!touched) return { errors, touched };

  const head = versionAt(root, 'HEAD', PLUGIN_JSON);
  if (head.missing) return { errors: [`${PLUGIN_JSON} is missing at HEAD but the change touches the package`], touched };
  if (head.error) return { errors: [head.error], touched };
  if (typeof head.value !== 'string' || !SEMVER.test(head.value)) return { errors: [`${PLUGIN_JSON}: version must be MAJOR.MINOR.PATCH, got ${JSON.stringify(head.value)}`], touched };

  const baseVersion = versionAt(root, base, PLUGIN_JSON);
  if (baseVersion.error) errors.push(baseVersion.error);
  else if (!baseVersion.missing) {
    // Fails closed: a base version that cannot be compared (such as 9.9.9-rc) must not read as "no base".
    if (typeof baseVersion.value !== 'string' || !SEMVER.test(baseVersion.value)) errors.push(`${PLUGIN_JSON} at ${base}: version ${JSON.stringify(baseVersion.value)} is not MAJOR.MINOR.PATCH, so it cannot be compared`);
    else if (compareSemver(head.value, baseVersion.value) <= 0) errors.push(`${PLUGIN_JSON}: version ${head.value} must be higher than the base's ${baseVersion.value}, because the change touches ${WATCHED.join(' or ')}`);
  }

  const market = versionAt(root, 'HEAD', MARKETPLACE_JSON);
  if (market.missing || market.error) errors.push(market.error ?? `${MARKETPLACE_JSON} is missing at HEAD`);
  else {
    let metaVersion;
    const raw = git(root, ['show', `HEAD:${MARKETPLACE_JSON}`]).out;
    try { metaVersion = JSON.parse(raw).metadata?.version; } catch { /* reported above */ }
    if (metaVersion !== head.value) errors.push(`${MARKETPLACE_JSON}: metadata.version ${JSON.stringify(metaVersion)} must equal plugin.json version ${head.value}`);
  }
  return { errors, touched };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootIdx = args.indexOf('--root');
  const root = resolve(rootIdx >= 0 ? args[rootIdx + 1] : process.cwd());
  const base = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--root');
  if (!base) {
    console.error('usage: node scripts/check-cursor-version-bump.mjs <base-ref> [--root <dir>]');
    process.exit(2);
  }
  const { errors, touched } = checkVersionBump(root, base);
  if (errors.length > 0) {
    for (const e of errors) console.error(`FAIL ${e}`);
    process.exit(1);
  }
  console.log(touched ? `OK: the Cursor package version was raised and matches the marketplace (base ${base})` : `OK: nothing under ${WATCHED.join(' or ')} changed since ${base}`);
}
