// Validates the plugin repository. Runs in CI and locally: `node scripts/validate.mjs`.
// Plain Node >= 20, no dependencies. Prints every failure and exits 1 if there is any.
//
//   --root <dir>   validate another tree (the tests do this with temp fixtures)
//   --url <url>    expected MCP URL (default production; or REPLYLAYER_EXPECTED_MCP_URL)
//   --no-claude    skip `claude plugin validate` even when the CLI is installed
//
// Each failure starts with a bracketed rule id, e.g. `[mcp-url]`, which the tests key on.
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// The one MCP URL. A change here is a security review item.
export const PRODUCTION_MCP_URL = 'https://api.replylayer.ai/v1/mcp/oauth';

export const CLAUDE_PKG = 'claude/replylayer';
export const OPENAI_PKG = 'openai/replylayer';

const PLUGIN_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/plugin.schema.json';
const MCP_SCHEMA = 'https://agent-plugins.org/schemas/1.0.0/mcp.schema.json';

const KEBAB = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RESERVED_NAME_WORDS = ['anthropic', 'claude', 'openai', 'official'];

const SKILL_FIELDS = new Set(['name', 'description', 'license']);
const SKILL_MAX_LINES = 299; // under 300
const DESCRIPTION_MAX = 1024;
const SKILLS_TOKEN_BUDGET = 5000; // chars / 4, all skills together
const README_MIN_WORDS = 40;

// Purchase wording must never appear in a skill, README or manifest description.
export const PURCHASE_RE = /pay-as-you-go|\$\d|upgrade|Starter|Pro plan|billing|credit|purchase|buy|subscription|pricing|paid plan|top-up/i;
// Skills use neutral wording ("the model" or "you"), one text for every vendor.
const VENDOR_WORD_RE = /\bclaude\b/i;

const KEY_SHAPED = /rly_live_[0-9a-z]{16}\.[A-Za-z0-9_-]{43}/;

// Zero-width, bidi-control and other invisible characters that can hide text.
const INVISIBLE_RE = /[\u00AD\u034F\u061C\u115F\u1160\u17B4\u17B5\u180B-\u180F\u200B-\u200F\u202A-\u202E\u2060-\u206F\u3164\uFE00-\uFE0F\uFEFF\uFFA0\u{E0000}-\u{E007F}]/u;

// Tool names registered on the hosted server (packages/mcp/src/tools/index.ts, REGISTERED_TOOL_NAMES).
// scripts/tool-names.json is the checked-in snapshot; a test fails if the two differ.
export const REGISTERED_TOOLS = new Set([
  'send_email', 'list_messages', 'read_message', 'get_thread', 'list_threads', 'reply_to_message',
  'wait_for_message', 'list_mailboxes', 'list_recipients', 'add_recipient', 'list_suppressions',
  'add_suppression', 'list_allowlist', 'list_allowlist_blocked_attempts', 'create_draft', 'list_drafts',
  'get_draft', 'delete_draft', 'update_draft', 'send_draft', 'list_inbound_blocklist',
  'add_inbound_blocklist', 'list_inbound_allowlist', 'add_inbound_allowlist_entry',
  'list_inbound_firewall_blocked_attempts', 'release_firewall_blocked_message', 'mark_message_read',
  'mark_thread_read', 'approve_review', 'deny_review', 'release_quarantined_message',
  'block_quarantined_message', 'report_and_block', 'delete_message', 'get_account_usage',
  'get_agent_quota', 'get_link_scanning_status', 'star_message', 'star_thread', 'get_attachment_preview',
  'add_inbound_allowlist_bulk', 'add_suppressions_bulk', 'add_inbound_blocklist_bulk', 'remove_suppression',
]);
// Left out of the sign-in (agent) grant at /v1/mcp/oauth (AGENT_UNAVAILABLE_TOOL_NAMES): never reference these.
export const HIDDEN_TOOLS = new Set(['approve_review', 'deny_review', 'get_account_usage', 'remove_suppression']);
const TOOL_VERB_RE = /^(send|list|read|get|add|release|block|report|delete|mark|star|unstar|wait|reply|create|update|approve|deny|remove|search|forward|move|archive)(_[a-z0-9]+)+$/;
// A snake_case word anywhere in the text, backticked or not.
const SNAKE_WORD_RE = /(?<![A-Za-z0-9_])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![A-Za-z0-9_])/g;

// Top-level keys the Agent Plugins schemas allow (additionalProperties: false).
const OPENAI_PLUGIN_KEYS = new Set(['$schema', 'name', 'version', 'description', 'author', 'homepage', 'repository', 'license', 'keywords', 'extensions']);
const OPENAI_AUTHOR_KEYS = new Set(['name', 'email', 'url']);
const OPENAI_MCP_KEYS = new Set(['$schema', 'mcpServers']);
const CLAUDE_MCP_KEYS = new Set(['mcpServers']);

const JUNK_NAMES = new Set(['.DS_Store', 'Thumbs.db', 'ehthumbs.db', 'desktop.ini']);
const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

export function estimateTokens(text) {
  return Math.ceil(text.length / 4);
}

// Tiny YAML-frontmatter parser for the forms the skills use: `key: value`, quoted values,
// and folded (`>`, `>-`) / literal (`|`, `|-`) blocks. Anything else is an error.
export function parseFrontmatter(text) {
  const src = text.replace(/\r\n/g, '\n');
  if (!src.startsWith('---\n')) return { error: 'must start with a `---` frontmatter block' };
  const end = src.indexOf('\n---', 4);
  if (end === -1) return { error: 'frontmatter block is not closed with `---`' };
  const afterFence = src.slice(end + 4);
  if (afterFence !== '' && !afterFence.startsWith('\n')) return { error: 'frontmatter closing fence must be alone on its line' };
  const lines = src.slice(4, end).split('\n');
  const data = {};
  const order = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trim() === '') { i += 1; continue; }
    const m = /^([A-Za-z_][A-Za-z0-9_-]*):(?:\s+(.*))?$/.exec(line);
    if (!m) return { error: `unsupported frontmatter line: ${JSON.stringify(line)}` };
    const key = m[1];
    if (key in data) return { error: `duplicate frontmatter key "${key}"` };
    let value = (m[2] ?? '').trim();
    i += 1;
    const block = /^([>|])[+-]?$/.exec(value);
    if (block || value === '') {
      const collected = [];
      while (i < lines.length && (lines[i].startsWith(' ') || lines[i].startsWith('\t') || lines[i].trim() === '')) {
        collected.push(lines[i].trim());
        i += 1;
      }
      while (collected.length && collected[collected.length - 1] === '') collected.pop();
      if (value === '' && collected.length === 0) return { error: `frontmatter key "${key}" has no value` };
      value = block && block[1] === '|' ? collected.join('\n') : collected.join(' ');
    } else if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2) || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      value = value.slice(1, -1);
    } else if (/^[[{&*!|>%@`]/.test(value) || /: /.test(value) || / #/.test(value)) {
      return { error: `frontmatter value for "${key}" needs quoting or uses unsupported YAML` };
    }
    data[key] = value;
    order.push(key);
  }
  return { data, keys: order, body: afterFence.replace(/^\n/, '') };
}

export function stripCodeBlocks(md) {
  return md.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, '');
}

export function countWords(md) {
  return stripCodeBlocks(md).split(/\s+/).filter((w) => /[A-Za-z]/.test(w)).length;
}

function walk(root, dir = '') {
  const out = [];
  const abs = join(root, dir);
  for (const name of readdirSync(abs).sort()) {
    if (name === '.git' || name === 'node_modules') continue;
    const rel = dir ? `${dir}/${name}` : name;
    const st = lstatSync(join(root, rel));
    out.push({ rel, name, isDir: st.isDirectory() && !st.isSymbolicLink(), isSymlink: st.isSymbolicLink() });
    if (st.isDirectory() && !st.isSymbolicLink()) out.push(...walk(root, rel));
  }
  return out;
}

export function validate(root, { mcpUrl = PRODUCTION_MCP_URL, runClaude = false } = {}) {
  const errors = [];
  const fail = (rule, msg) => errors.push(`[${rule}] ${msg}`);
  const p = (rel) => join(root, rel);
  const read = (rel) => readFileSync(p(rel), 'utf8');

  const readJson = (rel, rule) => {
    if (!existsSync(p(rel))) { fail(rule, `${rel}: missing`); return null; }
    try { return JSON.parse(read(rel)); } catch (err) { fail(rule, `${rel}: ${err.message}`); return null; }
  };

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const nonEmpty = (v) => typeof v === 'string' && v.trim() !== '';

  // ---- Required layout ----------------------------------------------------
  for (const rel of ['README.md', 'LICENSE', `${CLAUDE_PKG}/README.md`, `${CLAUDE_PKG}/LICENSE`]) {
    if (!existsSync(p(rel))) fail('license-readme', `${rel}: missing`);
  }
  for (const rel of ['LICENSE', `${CLAUDE_PKG}/LICENSE`]) {
    if (existsSync(p(rel)) && !/^MIT License/.test(read(rel))) fail('license-readme', `${rel}: must be the MIT license`);
  }

  // ---- Claude manifest ----------------------------------------------------
  const claudePlugin = readJson(`${CLAUDE_PKG}/.claude-plugin/plugin.json`, 'manifest-claude');
  const scanText = []; // manifest text checked for purchase wording
  if (claudePlugin) {
    const where = `${CLAUDE_PKG}/.claude-plugin/plugin.json`;
    if (!isObj(claudePlugin)) fail('manifest-claude', `${where}: must be an object`);
    else {
      if (claudePlugin.name !== 'replylayer') fail('manifest-claude', `${where}: name must be "replylayer" (permanent)`);
      if (!KEBAB.test(claudePlugin.name ?? '')) fail('manifest-claude', `${where}: name must be kebab-case`);
      for (const w of RESERVED_NAME_WORDS) if ((claudePlugin.name ?? '').includes(w)) fail('manifest-claude', `${where}: name must not contain reserved word "${w}"`);
      if (!nonEmpty(claudePlugin.displayName)) fail('manifest-claude', `${where}: displayName is required`);
      if (!SEMVER.test(claudePlugin.version ?? '')) fail('manifest-claude', `${where}: version must be MAJOR.MINOR.PATCH`);
      if (!nonEmpty(claudePlugin.description)) fail('manifest-claude', `${where}: description is required`);
      else scanText.push([where, claudePlugin.description]);
      if (!isObj(claudePlugin.author) || !nonEmpty(claudePlugin.author.name)) fail('manifest-claude', `${where}: author.name is required`);
      if (!/^https:\/\//.test(claudePlugin.homepage ?? '')) fail('manifest-claude', `${where}: homepage must be an https URL`);
      if (!/^https:\/\//.test(claudePlugin.repository ?? '')) fail('manifest-claude', `${where}: repository must be an https URL`);
      if (claudePlugin.license !== 'MIT') fail('manifest-claude', `${where}: license must be "MIT"`);
      if (Array.isArray(claudePlugin.keywords)) scanText.push([`${where} keywords`, claudePlugin.keywords.join(' ')]);
      if (!Array.isArray(claudePlugin.keywords) || claudePlugin.keywords.length === 0 || !claudePlugin.keywords.every(nonEmpty)) fail('manifest-claude', `${where}: keywords must be a non-empty array of strings`);
    }
  }

  // ---- MCP configs (Claude .mcp.json, OpenAI mcp.json) ---------------------
  const checkMcp = (rel, expectedType, expectedSchema, rule, allowedTop) => {
    const cfg = readJson(rel, rule);
    if (!cfg) return;
    if (!isObj(cfg) || !isObj(cfg.mcpServers)) { fail(rule, `${rel}: needs an mcpServers object`); return; }
    for (const k of Object.keys(cfg)) if (!allowedTop.has(k)) fail(rule, `${rel}: unexpected top-level key "${k}" (allowed: ${[...allowedTop].join(', ')})`);
    if (expectedSchema && cfg.$schema !== expectedSchema) fail(rule, `${rel}: $schema must be ${expectedSchema}`);
    const raw = read(rel);
    if (/"headers"|"userConfig"|\$\{/.test(raw)) fail('mcp-forbidden', `${rel}: must not contain headers, userConfig or \${...} (sign-in only, no secrets)`);
    const entries = Object.entries(cfg.mcpServers);
    if (entries.length !== 1) fail(rule, `${rel}: must declare exactly one server`);
    for (const [name, server] of entries) {
      if (name !== 'replylayer') fail(rule, `${rel}: server name must be "replylayer", got "${name}"`);
      if (!isObj(server)) { fail(rule, `${rel}: server "${name}" must be an object`); continue; }
      if (server.type !== expectedType) fail(rule, `${rel}: server "${name}" type must be "${expectedType}", got ${JSON.stringify(server.type)}`);
      if (server.url !== mcpUrl) fail('mcp-url', `${rel}: server "${name}" url must be exactly ${mcpUrl}, got ${JSON.stringify(server.url)}`);
      for (const k of Object.keys(server)) if (!['type', 'url'].includes(k)) fail('mcp-forbidden', `${rel}: server "${name}" has unexpected key "${k}"`);
    }
  };
  checkMcp(`${CLAUDE_PKG}/.mcp.json`, 'http', null, 'mcp-claude', CLAUDE_MCP_KEYS);
  checkMcp(`${OPENAI_PKG}/mcp.json`, 'streamable-http', MCP_SCHEMA, 'mcp-openai', OPENAI_MCP_KEYS);

  // ---- OpenAI manifest ----------------------------------------------------
  const oaPlugin = readJson(`${OPENAI_PKG}/plugin.json`, 'manifest-openai');
  if (oaPlugin) {
    const where = `${OPENAI_PKG}/plugin.json`;
    if (!isObj(oaPlugin)) fail('manifest-openai', `${where}: must be an object`);
    else {
      for (const k of Object.keys(oaPlugin)) if (!OPENAI_PLUGIN_KEYS.has(k)) fail('manifest-openai', `${where}: unexpected top-level key "${k}" (allowed: ${[...OPENAI_PLUGIN_KEYS].join(', ')})`);
      if (isObj(oaPlugin.author)) for (const k of Object.keys(oaPlugin.author)) if (!OPENAI_AUTHOR_KEYS.has(k)) fail('manifest-openai', `${where}: unexpected author key "${k}"`);
      if (Array.isArray(oaPlugin.keywords)) scanText.push([`${where} keywords`, oaPlugin.keywords.join(' ')]);
      if (oaPlugin.$schema !== PLUGIN_SCHEMA) fail('manifest-openai', `${where}: $schema must be ${PLUGIN_SCHEMA}`);
      if (oaPlugin.name !== 'replylayer') fail('manifest-openai', `${where}: name must be "replylayer"`);
      if (!SEMVER.test(oaPlugin.version ?? '')) fail('manifest-openai', `${where}: version must be MAJOR.MINOR.PATCH`);
      else if (claudePlugin && oaPlugin.version !== claudePlugin.version) fail('manifest-openai', `${where}: version ${oaPlugin.version} must equal the Claude plugin version ${claudePlugin.version}`);
      if (!nonEmpty(oaPlugin.description)) fail('manifest-openai', `${where}: description is required`);
      else {
        scanText.push([where, oaPlugin.description]);
        if (VENDOR_WORD_RE.test(oaPlugin.description)) fail('claude-wording', `${where}: description must not say "Claude"`);
      }
      if (!isObj(oaPlugin.author) || !nonEmpty(oaPlugin.author.name)) fail('manifest-openai', `${where}: author.name is required`);
      if (!/^https:\/\//.test(oaPlugin.homepage ?? '')) fail('manifest-openai', `${where}: homepage must be an https URL`);
      if (!/^https:\/\//.test(oaPlugin.repository ?? '')) fail('manifest-openai', `${where}: repository must be an https URL`);
      if (oaPlugin.license !== 'MIT') fail('manifest-openai', `${where}: license must be "MIT"`);
      if (!Array.isArray(oaPlugin.keywords) || oaPlugin.keywords.length === 0) fail('manifest-openai', `${where}: keywords must be a non-empty array`);
    }
  }
  if (existsSync(p(`${OPENAI_PKG}/.mcp.json`)) || existsSync(p(`${OPENAI_PKG}/.claude-plugin`))) {
    fail('manifest-openai', `${OPENAI_PKG}: must not carry Claude packaging (.mcp.json, .claude-plugin)`);
  }

  // ---- Skills (the source and every package copy) --------------------------
  const skillFiles = []; // { rel, dirName }
  for (const base of ['skills', `${CLAUDE_PKG}/skills`, `${OPENAI_PKG}/skills`]) {
    if (!existsSync(p(base))) { fail('skill-frontmatter', `${base}: missing`); continue; }
    for (const name of readdirSync(p(base)).sort()) {
      const st = lstatSync(p(`${base}/${name}`));
      if (!st.isDirectory()) { fail('skill-frontmatter', `${base}/${name}: only skill folders belong here`); continue; }
      if (!existsSync(p(`${base}/${name}/SKILL.md`))) { fail('skill-frontmatter', `${base}/${name}: missing SKILL.md`); continue; }
      skillFiles.push({ rel: `${base}/${name}/SKILL.md`, dirName: name });
    }
  }
  const skillDirs = readdirSync(p('skills')).filter((n) => existsSync(p(`skills/${n}/SKILL.md`)));
  if (skillDirs.length === 0 || skillDirs.length > 5) fail('skill-frontmatter', `skills/: expected 1-5 skills (OpenAI caps MCP-imported skills at five), found ${skillDirs.length}`);

  let tokenTotal = 0;
  for (const { rel, dirName } of skillFiles) {
    const text = read(rel);
    if (rel.startsWith('skills/')) tokenTotal += estimateTokens(text);
    const fm = parseFrontmatter(text);
    if (fm.error) { fail('skill-frontmatter', `${rel}: ${fm.error}`); }
    else {
      for (const k of fm.keys) if (!SKILL_FIELDS.has(k)) fail('skill-frontmatter', `${rel}: unsupported frontmatter field "${k}" (allowed: ${[...SKILL_FIELDS].join(', ')})`);
      if (!nonEmpty(fm.data.name)) fail('skill-name', `${rel}: name is required`);
      else {
        if (fm.data.name !== dirName) fail('skill-name', `${rel}: name "${fm.data.name}" must equal its folder "${dirName}"`);
        if (fm.data.name.length > 64 || !KEBAB.test(fm.data.name) || fm.data.name.includes('--')) fail('skill-name', `${rel}: name must be kebab-case, at most 64 characters, no "--"`);
      }
      if (!nonEmpty(fm.data.description)) fail('skill-description', `${rel}: description is required`);
      else if (fm.data.description.length > DESCRIPTION_MAX) fail('skill-description', `${rel}: description is ${fm.data.description.length} characters, limit ${DESCRIPTION_MAX}`);
      if (fm.body.trim() === '') fail('skill-frontmatter', `${rel}: empty body`);
    }
    const lineCount = text.replace(/\n$/, '').split('\n').length;
    if (lineCount > SKILL_MAX_LINES) fail('skill-lines', `${rel}: ${lineCount} lines, must be under 300`);
    if (VENDOR_WORD_RE.test(text)) fail('claude-wording', `${rel}: skills use neutral wording ("the model" or "you"), never "Claude"`);
    if (/https?:\/\//i.test(text)) fail('skill-url', `${rel}: skills must not contain URLs (never pull instructions from links)`);
    if (/<!--/.test(text)) fail('hidden-content', `${rel}: HTML comments can hide instructions`);
    if (INVISIBLE_RE.test(text)) fail('hidden-content', `${rel}: contains invisible or bidirectional-control characters`);
    if (/data:[a-z]+\/[a-z0-9.+-]+[;,]|[A-Za-z0-9+/=]{80,}/i.test(text)) fail('hidden-content', `${rel}: contains a data: URI or an encoded blob`);
    // Backticked or not, frontmatter included: any snake_case word shaped like a tool name.
    for (const tok of new Set(text.match(SNAKE_WORD_RE) ?? [])) {
      if (HIDDEN_TOOLS.has(tok)) fail('hidden-tool', `${rel}: references ${tok}, which is not available on the sign-in connection`);
      else if (TOOL_VERB_RE.test(tok) && !REGISTERED_TOOLS.has(tok)) fail('unknown-tool', `${rel}: ${tok} is not a ReplyLayer tool`);
    }
  }
  if (tokenTotal > SKILLS_TOKEN_BUDGET) fail('skills-tokens', `skills/: about ${tokenTotal} tokens, keep under ${SKILLS_TOKEN_BUDGET}`);

  // ---- Copies match skills/ -----------------------------------------------
  for (const pkg of [CLAUDE_PKG, OPENAI_PKG]) {
    const dest = `${pkg}/skills`;
    if (!existsSync(p(dest))) continue;
    const srcNames = new Set(readdirSync(p('skills')));
    const destNames = new Set(readdirSync(p(dest)));
    for (const n of srcNames) {
      if (!destNames.has(n)) { fail('skill-drift', `${dest}/${n}: missing (run node scripts/sync-skills.mjs)`); continue; }
      const a = p(`skills/${n}/SKILL.md`);
      const b = p(`${dest}/${n}/SKILL.md`);
      if (existsSync(a) && existsSync(b) && !readFileSync(a).equals(readFileSync(b))) fail('skill-drift', `${dest}/${n}/SKILL.md differs from skills/${n}/SKILL.md (run node scripts/sync-skills.mjs)`);
    }
    for (const n of destNames) if (!srcNames.has(n)) fail('skill-drift', `${dest}/${n}: not in skills/`);
  }

  // ---- README ---------------------------------------------------------------
  if (existsSync(p(`${CLAUDE_PKG}/README.md`))) {
    const words = countWords(read(`${CLAUDE_PKG}/README.md`));
    if (words < README_MIN_WORDS) fail('readme-words', `${CLAUDE_PKG}/README.md: ${words} words outside code blocks, need at least ${README_MIN_WORDS}`);
  }

  // ---- Purchase wording ------------------------------------------------------
  for (const { rel } of skillFiles) scanText.push([rel, read(rel)]);
  for (const rel of ['README.md', `${CLAUDE_PKG}/README.md`]) if (existsSync(p(rel))) scanText.push([rel, read(rel)]);
  for (const [where, text] of scanText) {
    const m = PURCHASE_RE.exec(text);
    if (m) fail('purchase-wording', `${where}: contains purchase wording "${m[0]}"`);
  }

  // ---- Whole-tree file hygiene ---------------------------------------------
  const decoder = new TextDecoder('utf-8', { fatal: true });
  for (const { rel, name, isDir, isSymlink } of walk(root)) {
    if (isSymlink) { fail('fs-symlink', `${rel}: symlinks are not allowed`); continue; }
    if (isDir) {
      if (name === 'bin') fail('fs-bin', `${rel}: bin/ directories are not allowed (claude.ai refuses them)`);
      continue;
    }
    if (name === '.gitattributes') fail('fs-gitattributes', `${rel}: .gitattributes is not allowed (export/filter attributes)`);
    if (JUNK_NAMES.has(name) || name.startsWith('._') || name.endsWith('~') || /\.(swp|swo|orig|rej)$/.test(name)) fail('fs-junk', `${rel}: OS or editor junk file`);
    const buf = readFileSync(p(rel));
    if (IMAGE_EXT.test(name)) continue;
    let text = null;
    try { text = decoder.decode(buf); } catch { /* fallthrough */ }
    if (text === null || buf.includes(0)) { fail('fs-binary', `${rel}: not a plain text file`); continue; }
    if (KEY_SHAPED.test(text)) fail('key-shaped', `${rel}: contains a key-shaped rly_live_ string`);
  }

  // ---- claude plugin validate (only when asked and the CLI exists) ----------
  if (runClaude) {
    const probe = spawnSync('claude', ['--version'], { encoding: 'utf8' });
    if (probe.error || probe.status !== 0) {
      console.log('note: `claude` CLI not available, skipping `claude plugin validate` (run it locally before submitting)');
    } else {
      const res = spawnSync('claude', ['plugin', 'validate', p(CLAUDE_PKG)], { encoding: 'utf8' });
      if (res.status !== 0) fail('claude-cli', `claude plugin validate ${CLAUDE_PKG} failed (exit ${res.status}): ${(res.stdout + res.stderr).trim()}`);
      else console.log(`claude plugin validate ${CLAUDE_PKG}: OK`);
    }
  }

  return errors;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const flag = (name) => { const i = args.indexOf(name); return i >= 0 ? args[i + 1] : undefined; };
  const root = resolve(flag('--root') ?? process.cwd());
  const mcpUrl = flag('--url') ?? process.env.REPLYLAYER_EXPECTED_MCP_URL ?? PRODUCTION_MCP_URL;
  const errors = validate(root, { mcpUrl, runClaude: !args.includes('--no-claude') });
  if (errors.length > 0) {
    for (const e of errors) console.error(`FAIL ${e}`);
    process.exit(1);
  }
  console.log(`OK: manifests, MCP URL (${mcpUrl}), skills, copies and file hygiene all valid`);
}
