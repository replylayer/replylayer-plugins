// Copies skills/ (the one source) into each package's skills/ folder.
// `--check` changes nothing and exits 1 if any copy differs from the source.
// `--root <dir>` runs against another tree (used by the tests).
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGES = ['claude/replylayer', 'openai/replylayer'];

function listFiles(dir, base = dir) {
  const out = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...listFiles(full, base));
    else out.push(full.slice(base.length + 1));
  }
  return out;
}

// Returns human-readable drift descriptions; empty when the copies match.
export function findDrift(root) {
  const src = join(root, 'skills');
  const srcFiles = listFiles(src);
  const drift = [];
  for (const pkg of PACKAGES) {
    const dest = join(root, pkg, 'skills');
    const destFiles = listFiles(dest);
    for (const f of srcFiles) {
      if (!destFiles.includes(f)) drift.push(`${pkg}/skills/${f}: missing`);
      else if (!readFileSync(join(src, f)).equals(readFileSync(join(dest, f)))) drift.push(`${pkg}/skills/${f}: differs from skills/${f}`);
    }
    for (const f of destFiles) if (!srcFiles.includes(f)) drift.push(`${pkg}/skills/${f}: not in skills/`);
  }
  return drift;
}

export function sync(root) {
  for (const pkg of PACKAGES) {
    const dest = join(root, pkg, 'skills');
    rmSync(dest, { recursive: true, force: true });
    mkdirSync(dest, { recursive: true });
    cpSync(join(root, 'skills'), dest, { recursive: true, dereference: false });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const rootIdx = args.indexOf('--root');
  const root = rootIdx >= 0 ? resolve(args[rootIdx + 1]) : process.cwd();
  if (args.includes('--check')) {
    const drift = findDrift(root);
    if (drift.length > 0) {
      for (const d of drift) console.error(`DRIFT ${d}`);
      console.error('Run: node scripts/sync-skills.mjs');
      process.exit(1);
    }
    console.log('OK: package skill copies match skills/');
  } else {
    sync(root);
    console.log(`Synced skills/ into ${PACKAGES.join(', ')}`);
  }
}
