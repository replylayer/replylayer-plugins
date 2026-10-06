// Validates the plugin repository. Runs in CI and locally: `node scripts/validate.mjs`.
// Plain Node >= 20, no dependencies. Prints every failure and exits 1 if there is any.
//
//   --root <dir>   validate another tree (the tests do this with temp fixtures)
//   --url <url>    expected MCP URL (default production; or REPLYLAYER_EXPECTED_MCP_URL)
//   --no-claude    skip `claude plugin validate` even when the CLI is installed
//   --print-cursor-hashes   print CURSOR_CONTENT_PINS for the current tree (paste over the constant) and exit
//
// Each failure starts with a bracketed rule id, e.g. `[mcp-url]`, which the tests key on.
// The Cursor package (cursor/replylayer, an agent API key in a setup field, not a sign-in) has its own `cursor-*` rules; the OAuth-only rules do not apply to it.
import { existsSync, lstatSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { isAbsolute, join, normalize, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { createHash } from 'node:crypto';

// The one MCP URL. A change here is a security review item.
export const PRODUCTION_MCP_URL = 'https://api.replylayer.ai/v1/mcp/oauth';

export const CLAUDE_PKG = 'claude/replylayer';
export const OPENAI_PKG = 'openai/replylayer';
export const CURSOR_PKG = 'cursor/replylayer';

// The Cursor package uses an agent API key from a setup field (not a sign-in), so its URL is the key endpoint, not the OAuth one.
// A change here is a security review item: this is the only place the key can be sent.
export const CURSOR_MCP_URL = 'https://api.replylayer.ai/v1/mcp';
export const CURSOR_MARKETPLACE = '.cursor-plugin/marketplace.json';
const CURSOR_MARKETPLACE_SOURCE = `./${CURSOR_PKG}`;
const CURSOR_MARKETPLACE_KEYS = ['name', 'owner', 'metadata', 'plugins'];
const CURSOR_METADATA_KEYS = new Set(['description', 'version']);
const CURSOR_ENTRY_KEYS = ['name', 'source', 'description'];
// Fields Cursor reads as component paths or overrides; none may appear in the manifest.
const CURSOR_COMPONENT_FIELDS = new Set(['mcpServers', 'skills', 'rules', 'agents', 'commands', 'hooks']);
const CURSOR_MANIFEST_KEYS = new Set(['name', 'description', 'version', 'author', 'homepage', 'repository', 'license', 'keywords', 'logo', 'variables']);
// The whole package: nothing else may sit in the folder.
const CURSOR_FILES = [
  '.cursor-plugin/plugin.json', 'mcp.json', 'assets/logo.svg', 'skills/replylayer-email/SKILL.md', 'LICENSE', 'README.md',
];
const CURSOR_DIRS = new Set(['.cursor-plugin', 'assets', 'skills', 'skills/replylayer-email']);
// The only manifest-shaped files the repository may hold (basename plugin.json, mcp.json, .mcp.json, marketplace*.json).
const MANIFEST_ALLOWLIST = [
  '.cursor-plugin/marketplace.json', `${CURSOR_PKG}/.cursor-plugin/plugin.json`, `${CURSOR_PKG}/mcp.json`,
  'claude/replylayer/.claude-plugin/plugin.json', 'claude/replylayer/.mcp.json',
  'openai/replylayer/plugin.json', 'openai/replylayer/mcp.json',
];
// The repository's top-level entries (the working tree's own .git aside) and the only things under .github/. Cursor
// reads agent configuration from the repository root (hooks, rules, agents, commands, AGENTS.md, .cursorrules,
// .mcp.json ...), so a new top-level entry must be added to this list in the same PR, where review sees it.
const ROOT_ALLOWLIST = ['.cursor-plugin', '.github', 'LICENSE', 'README.md', 'claude', 'cursor', 'openai', 'scripts', 'skills'];
const GITHUB_ALLOWLIST = ['workflows', 'dependabot.yml'];
const CURSOR_SKILL_FIELDS = new Set(['name', 'description']);
// The skill's add_recipient ban is pinned (option A): rule 1 and the two prohibition sentences must appear
// verbatim, and exactly two lines may mention add_recipient or attest. Changing any of it needs an edit to
// these constants in the same PR, which review then sees. This makes a change explicit; it cannot stop a
// maintainer who edits both, which is what the repository ruleset is for.
export const CURSOR_SKILL_RULE1 = "## 1. The API key stays out of chat\n\nThe key lives in this plugin's setup field.\n\n- Never ask the user for an API key, token, or key prefix. Never repeat one, and never put one in a message, a file, a shell command, or a tool argument.\n- If a tool fails with an authentication error (`UNAUTHORIZED`, `401`, \"unauthorized\", or \"authentication failed\"), tell the user to open Plugins \u2192 ReplyLayer \u2192 Configure and re-enter the agent key there, with no `Bearer` prefix. Then stop.\n- If a tool fails with `API_KEY_REVOKED`, the key was revoked. Tell the user to create a new agent key in the ReplyLayer dashboard and enter it under Configure. Then stop.\n- A rate-limit error (`RATE_LIMITED`, `429`, or \"too many requests\") whose `details.reason` is `failed_authentication`, or whose message says to check the API key, is an authentication error. Handle it like the authentication-error bullet above, and do not wait and retry. If a rate-limit error appears on every call right after the key was set up or changed, handle it the same way.\n- Never offer to install or reconfigure this plugin through chat.\n\n";
// The two full lines (the add_recipient bullet and the SANDBOX_RECIPIENT_NOT_VERIFIED paragraph) are the ONLY
// lines that may mention add_recipient or attest, and they must match exactly: extra text on either is a change.
export const CURSOR_SKILL_PINNED_LINES = ["- Do not call `add_recipient`. By default it emails a confirmation request to a third party, and its `attest` option spends one of the account's limited trial attestations without sending any email. Ask the user to add the person themselves.", "On `SANDBOX_RECIPIENT_NOT_VERIFIED`, stop and ask the user to add the person in the ReplyLayer dashboard. On the free trial, an account can email its own address, ReplyLayer's simulator test addresses, a reply to someone whose inbound message passed sender authentication for its own domain, people who confirmed by clicking a link or whom the account owner vouched for, and any other route the account has unlocked. The refusal means none of those applied to this recipient. `list_recipients` shows who is confirmed. Never call `add_recipient`, with or without `attest`, to get past this refusal."];
// Variation selectors (the shared set stops at U+FE0F), U+2800 and U+FFFC render as nothing or as a blank.
// Applied to files under cursor/ only: widening the shared rules would change claude/openai validation.
// \p{Cf} is every Unicode format character; the rest are listed because they are not format characters or
// are interlinear/musical formatting a reader never sees.
const CURSOR_HIDDEN_RE = /[\p{Cf}\u{E0100}-\u{E01EF}\u2800\uFFFC\uFFF9-\uFFFB\u{1D173}-\u{1D17A}]/u;
const CURSOR_HIDDEN_MESSAGE = 'contains a hidden character (a Unicode format character, variation selector, U+2800 or U+FFFC)';
const CURSOR_JSON_MAX_DEPTH = 64;
const CURSOR_HOMEPAGE = 'https://replylayer.ai/docs/mcp';
const CURSOR_REPOSITORY = 'https://github.com/replylayer/replylayer-plugins';
const CURSOR_KEY_VAR = 'REPLYLAYER_API_KEY';
const CURSOR_KEY_LENGTH = 69;
// The one MCP config the package may carry: any other URL, server, header, command, args or env fails.
export const CURSOR_MCP_CONFIG = {
  mcpServers: { replylayer: { url: CURSOR_MCP_URL, headers: { Authorization: `Bearer \${${CURSOR_KEY_VAR}}` } } },
};
// Keywords the Grok Bot desktop daemon's strict variables schema accepts; anything else makes the manifest invalid there.
const CURSOR_SCHEMA_KEYWORDS = new Set([
  'type', 'title', 'description', 'format', 'writeOnly', 'default',
  'properties', 'required', 'additionalProperties', 'items',
  'minLength', 'maxLength', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum',
  'minItems', 'maxItems',
]);

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

// Which lines of `text` mention add_recipient or attest, once the text is normalised the way a reader sees it:
// HTML tags removed, HTML character references decoded (numeric, and named such as &lowbar;), NFKC, lowercase,
// and backticks, backslashes, Markdown emphasis asterisks, format characters and variation selectors dropped;
// `-`, `_` and spaces between "add" and "recipient" count alike, and a token split across a line break is
// joined. Returns 0-based line indexes (every line a match overlaps).
const MENTION_STRIP_RE = new RegExp(`${INVISIBLE_RE.source}|\\p{Cf}|[\\u{E0100}-\\u{E01EF}]|[\`\\\\*]`, 'gu');
const NAMED_REFS = {
  lowbar: '_', underbar: '_', low: '_', hyphen: '-', dash: '-', minus: '-', sol: '/', ast: '*', midast: '*',
  nbsp: ' ', ensp: ' ', emsp: ' ', thinsp: ' ', tab: ' ', newline: ' ',
};
function decodeHtmlRefs(s) {
  return s
    .replace(/&#(x[0-9a-f]+|[0-9]+);?/gi, (m, n) => {
      const cp = /^x/i.test(n) ? parseInt(n.slice(1), 16) : parseInt(n, 10);
      return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '';
    })
    // An unknown named reference is dropped, which only widens what counts as a mention.
    .replace(/&([A-Za-z][A-Za-z0-9]*);/g, (m, name) => NAMED_REFS[name.toLowerCase()] ?? '');
}
export function mentionLines(text) {
  const withoutTags = text.replace(/<[^>]*>/g, (m) => m.replace(/[^\n]/g, ''));
  const pieces = withoutTags.split(/\r?\n/).map((line) => decodeHtmlRefs(line).normalize('NFKC').toLowerCase().replace(MENTION_STRIP_RE, ''));
  const starts = [];
  let pos = 0;
  for (const piece of pieces) { starts.push(pos); pos += piece.length; }
  const flagged = new Set();
  for (const m of pieces.join('').matchAll(/add[\s_-]*recipient|attest/g)) {
    const end = m.index + m[0].length;
    pieces.forEach((piece, i) => { if (piece.length > 0 && starts[i] < end && starts[i] + piece.length > m.index) flagged.add(i); });
  }
  return [...flagged].sort((a, b) => a - b);
}

// For each line: true when it sits inside a fenced code block or a blockquote (a lazy continuation line counts).
export function fencedOrQuotedLines(lines) {
  let fence = null;
  let quote = false;
  return lines.map((line) => {
    let inFence = fence !== null;
    const m = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) { if (m && m[1][0] === fence[0] && m[1].length >= fence.length && line.slice(m[0].length).trim() === '') fence = null; }
    else if (m) { fence = m[1]; inFence = true; }
    quote = /^ {0,3}>/.test(line) || (quote && line.trim() !== '');
    return inFence || quote;
  });
}

// Decodes the escapes of a YAML double-quoted scalar, so `approve\x5Freview` is read as approve_review.
export function decodeYamlDouble(s) {
  const simple = { n: '\n', t: '\t', r: '\r', 0: '\0', _: '\u00a0', N: '\u0085', L: '\u2028', P: '\u2029', e: '\u001b', a: '\u0007', b: '\b', f: '\f', v: '\v' };
  return s.replace(/\\(x[0-9A-Fa-f]{2}|u[0-9A-Fa-f]{4}|U[0-9A-Fa-f]{8}|.)/g, (m, e) => {
    if (e.length > 1) { const cp = parseInt(e.slice(1), 16); return cp <= 0x10ffff ? String.fromCodePoint(cp) : m; }
    return e in simple ? simple[e] : e;
  });
}

// Safety rules for any skill text, applied to the shared skills, both package copies and the Cursor skill.
// Each failure goes through `fail(rule, message)`.
function checkSkillText(rel, text, fail) {
  const lineCount = text.replace(/\n$/, '').split('\n').length;
  if (lineCount > SKILL_MAX_LINES) fail('skill-lines', `${rel}: ${lineCount} lines, must be under 300`);
  if (VENDOR_WORD_RE.test(text)) fail('claude-wording', `${rel}: skills use neutral wording ("the model" or "you"), never "Claude"`);
  if (/https?:\/\//i.test(text)) fail('skill-url', `${rel}: skills must not contain URLs (never pull instructions from links)`);
  if (/<!--/.test(text)) fail('hidden-content', `${rel}: HTML comments can hide instructions`);
  if (INVISIBLE_RE.test(text)) fail('hidden-content', `${rel}: contains invisible or bidirectional-control characters`);
  if (/data:[a-z]+\/[a-z0-9.+-]+[;,]|[A-Za-z0-9+/=]{80,}/i.test(text)) fail('hidden-content', `${rel}: contains a data: URI or an encoded blob`);
  checkToolNames(rel, text, fail);
}

// Backticked or not, frontmatter included: any snake_case word shaped like a tool name.
function checkToolNames(rel, text, fail) {
  for (const tok of new Set(text.match(SNAKE_WORD_RE) ?? [])) {
    if (HIDDEN_TOOLS.has(tok)) fail('hidden-tool', `${rel}: references ${tok}, which is not available on the sign-in connection`);
    else if (TOOL_VERB_RE.test(tok) && !REGISTERED_TOOLS.has(tok)) fail('unknown-tool', `${rel}: ${tok} is not a ReplyLayer tool`);
  }
}

// Deepest { / [ nesting of JSON text, counted without recursion (a deep array must not overflow the stack).
export function jsonDepth(text) {
  let depth = 0;
  let max = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (inString) { if (c === '\\') i += 1; else if (c === '"') inString = false; }
    else if (c === '"') inString = true;
    else if (c === '{' || c === '[') { depth += 1; if (depth > max) max = depth; }
    else if (c === '}' || c === ']') depth -= 1;
  }
  return max;
}

// Returns what is wrong with an MCP config, as messages without the file prefix; empty means it equals the one
// allowed config. The final fallback keeps a diagnostic gap from ever passing: only enumerable string keys are
// diagnosed above it, so a config that differs some other way (for example by a symbol key) still fails.
export function cursorMcpProblems(cfg) {
  const out = [];
  if (isDeepStrictEqual(cfg, CURSOR_MCP_CONFIG)) return out;
  const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!isObject(cfg)) out.push('must be an object');
  else {
    for (const k of Object.keys(cfg)) if (k !== 'mcpServers') out.push(`unexpected top-level key "${k}"`);
    if (!isObject(cfg.mcpServers)) out.push('needs an mcpServers object');
    else {
      for (const name of Object.keys(cfg.mcpServers)) if (name !== 'replylayer') out.push(`unexpected server "${name}" (only "replylayer")`);
      const server = cfg.mcpServers.replylayer;
      if (server === undefined) out.push('server "replylayer" is missing');
      else if (!isObject(server)) out.push('server "replylayer" must be an object');
      else {
        if (server.url !== CURSOR_MCP_URL) out.push(`server "replylayer" url must be exactly ${CURSOR_MCP_URL}, got ${JSON.stringify(server.url)}`);
        for (const k of Object.keys(server)) if (!['url', 'headers'].includes(k)) out.push(`server "replylayer" has unexpected key "${k}"`);
        const headers = server.headers;
        const wantHeader = CURSOR_MCP_CONFIG.mcpServers.replylayer.headers.Authorization;
        if (!isObject(headers)) out.push('server "replylayer" needs a headers object');
        else {
          if (headers.Authorization !== wantHeader) out.push(`header Authorization must be exactly ${JSON.stringify(wantHeader)}, got ${JSON.stringify(headers.Authorization)}`);
          for (const h of Object.keys(headers)) if (h !== 'Authorization') out.push(`unexpected header "${h}" (only Authorization)`);
        }
      }
    }
  }
  if (out.length === 0) out.push('must equal the one allowed MCP config exactly');
  return out;
}

// SHA-256 (hex) of the raw committed bytes of every shipped Cursor file: no line-ending normalisation, so a
// Windows checkout with core.autocrlf=true fails locally by design (CI and Cursor read LF). Option B of the
// add_recipient ban: a text rule cannot close a paraphrase, so a change to any of these files must edit its
// line here in the same PR, which review sees. After a deliberate change run
// `node scripts/validate.mjs --print-cursor-hashes` and paste the output over this constant.
// PINS-BEGIN
export const CURSOR_CONTENT_PINS = {
  '.cursor-plugin/marketplace.json': '318d32b2d337a4803e62cc208c304f92e1afffe3ace2ebb29b5deffb87629c52',
  'cursor/replylayer/.cursor-plugin/plugin.json': 'f3738aad61f5aa50b3b6ba5bbe7ca6f0ed603b87bb2b1af8eacb4f91578764d4',
  'cursor/replylayer/LICENSE': 'fbe86a9d63ded0773c756e389d6f56395059c2311801f7945219486cd974ba5d',
  'cursor/replylayer/README.md': '6fdd7b6ad71ba01798998172c9ad1116ff6aa23120acd563b3e44ceb85bacc39',
  'cursor/replylayer/assets/logo.svg': '7bfe12f04d786e2cc4470be96f6016b3f2c53ffed27b5978aa464b2cc4a5b5ef',
  'cursor/replylayer/mcp.json': '1d5f22efcee93c71fde6aec88ea3b7acc1c3239b7bfbb4318a0db91f54a53881',
  'cursor/replylayer/skills/replylayer-email/SKILL.md': 'b99f3f955dec721af16b5d489582bb8df65289f524de25c0ad8451408032a9d0',
};
// PINS-END

export function cursorContentHashes(root) {
  const files = [CURSOR_MARKETPLACE];
  const walkFiles = (dir) => {
    for (const name of readdirSync(join(root, dir)).sort()) {
      const rel = `${dir}/${name}`;
      const st = lstatSync(join(root, rel));
      if (st.isDirectory() && !st.isSymbolicLink()) walkFiles(rel);
      else if (st.isFile()) files.push(rel);
    }
  };
  if (existsSync(join(root, CURSOR_PKG)) && lstatSync(join(root, CURSOR_PKG)).isDirectory()) walkFiles(CURSOR_PKG);
  const out = {};
  for (const rel of files.sort()) {
    if (existsSync(join(root, rel)) && lstatSync(join(root, rel)).isFile()) out[rel] = createHash('sha256').update(readFileSync(join(root, rel))).digest('hex');
  }
  return out;
}

// The constant's exact text, so --print-cursor-hashes output can be pasted over it.
export function formatCursorPins(map) {
  const body = Object.keys(map).sort().map((k) => `  '${k}': '${map[k]}',\n`).join('');
  return `export const CURSOR_CONTENT_PINS = {\n${body}};\n`;
}

// Conservative text check for the Cursor logo: returns what is wrong, as fragments after "logo ". Only the two
// W3C xmlns declarations and #fragment hrefs are allowed; scripts, style imports, URLs, entities and non-ASCII
// bytes are not, so the file cannot load anything or hide anything.
export function checkLogo(buf) {
  const msgs = [];
  if (buf.some((b) => b > 0x7f)) msgs.push('must be ASCII only (found a non-ASCII byte)');
  const text = buf.toString('latin1');
  const forbidden = [
    [/[\s"'/]on[a-z]+\s*=/i, 'must not contain an on* event-handler attribute'],
    [/url\s*\(/i, 'must not contain url('],
    [/@import/i, 'must not contain @import'],
    [/<foreignObject/i, 'must not contain <foreignObject'],
    [/<script/i, 'must not contain <script'],
    [/<style/i, 'must not contain <style'],
    [/<\/?[A-Za-z_][\w.-]*:[A-Za-z_]/, 'must not contain a namespace-prefixed element'],
    [/<!DOCTYPE/i, 'must not contain <!DOCTYPE'],
    [/<!ENTITY/i, 'must not contain <!ENTITY'],
    [/data:/i, 'must not contain data:'],
    [/javascript:/i, 'must not contain javascript:'],
    [/&#/, 'must not contain a character reference (&#)'],
  ];
  for (const [re, msg] of forbidden) if (re.test(text)) msgs.push(msg);
  const quotedHrefs = [...text.matchAll(/href\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)];
  if ((text.match(/href/gi) ?? []).length !== quotedHrefs.length) msgs.push('must not use an href that is not a quoted value');
  for (const m of quotedHrefs) if (!(m[1] ?? m[2]).startsWith('#')) msgs.push('must not use an href that is not a #fragment');
  // Only the default SVG namespace and `xmlns:xlink` with the XLink URI may be declared; any other prefix could
  // rebind an element name to the SVG namespace (`<s:script xmlns:s=...>`) and slip past the checks above.
  const xmlns = [...text.matchAll(/xmlns(:[A-Za-z0-9_.-]+)?\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)];
  const nsOk = (m) => (m[1] === undefined ? (m[2] ?? m[3]) === 'http://www.w3.org/2000/svg' : m[1] === ':xlink' && (m[2] ?? m[3]) === 'http://www.w3.org/1999/xlink');
  if ((text.match(/xmlns/gi) ?? []).length !== xmlns.length || !xmlns.every(nsOk)) msgs.push('must not have an xmlns declaration other than the two W3C ones');
  return msgs;
}

// Returns the paths of duplicate keys in JSON text, at any depth ("$.mcpServers.replylayer.url"). Keys are
// compared after decoding, so "u\u0072l" duplicates "url". JSON.parse keeps the last duplicate, and a parser
// that keeps the first (or errors) would read a different URL, so the Cursor files must have none.
// Expects syntactically valid JSON (callers run JSON.parse first).
export function findDuplicateKeys(text) {
  const dups = [];
  let i = 0;
  const ws = () => { while (i < text.length && ' \t\n\r'.includes(text[i])) i += 1; };
  const str = () => {
    const start = i;
    i += 1;
    while (text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i += 1;
    return JSON.parse(text.slice(start, i));
  };
  const value = (path, depth = 1) => {
    if (depth > CURSOR_JSON_MAX_DEPTH) throw new RangeError(`JSON nesting is deeper than ${CURSOR_JSON_MAX_DEPTH} levels`);
    ws();
    const c = text[i];
    if (c === '{') {
      i += 1;
      const seen = new Set();
      ws();
      if (text[i] === '}') { i += 1; return; }
      for (;;) {
        ws();
        const key = str();
        if (seen.has(key)) dups.push(`${path}.${key}`);
        seen.add(key);
        ws();
        i += 1; // the colon
        value(`${path}.${key}`, depth + 1);
        ws();
        const sep = text[i];
        i += 1;
        if (sep !== ',') return;
      }
    } else if (c === '[') {
      i += 1;
      ws();
      if (text[i] === ']') { i += 1; return; }
      for (let n = 0; ; n += 1) {
        value(`${path}[${n}]`, depth + 1);
        ws();
        const sep = text[i];
        i += 1;
        if (sep !== ',') return;
      }
    } else if (c === '"') str();
    else while (i < text.length && !',]} \t\n\r'.includes(text[i])) i += 1;
  };
  value('$');
  return dups;
}

// Like walk(), but skips nothing (not node_modules, not .git): used where "nothing else may be here" matters.
// `skipTop` names entries of the walk root itself to leave out (the repository's own .git).
function walkAll(root, dir = '', skipTop = []) {
  const out = [];
  for (const name of readdirSync(join(root, dir)).sort()) {
    if (!dir && skipTop.includes(name)) continue;
    const rel = dir ? `${dir}/${name}` : name;
    const st = lstatSync(join(root, rel));
    const isDir = st.isDirectory() && !st.isSymbolicLink();
    out.push({ rel, name, isDir, isSymlink: st.isSymbolicLink() });
    if (isDir) out.push(...walkAll(root, rel));
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
    checkSkillText(rel, text, fail);
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

  // ---- Cursor package (effective configuration, not file shape) -------------
  // The package uses an agent API key entered in the plugin's setup field (not a sign-in), so the rules that are
  // specific to the sign-in (OAuth) connection above do not apply to it: the OAuth URL, `type`/`$schema` MCP shapes, the no-`headers`
  // rule and the Claude/OpenAI manifest rules. It is outside the skill sync: its skill is hand-maintained.
  // Every check below is independent of which of a marketplace entry and a manifest Cursor lets win for a field.
  const cursorDir = (rel) => `${CURSOR_PKG}/${rel}`;
  const keysOf = (o) => Object.keys(o);
  // Reports unexpected and missing keys of `obj` against an exact key list.
  const exactKeys = (rule, where, obj, expected) => {
    for (const k of keysOf(obj)) if (!expected.includes(k)) fail(rule, `${where}: unexpected key "${k}" (allowed: ${expected.join(', ')})`);
    for (const k of expected) if (!(k in obj)) fail(rule, `${where}: missing key "${k}"`);
  };
  // JSON.parse keeps the last duplicate key; a parser that keeps the first would read different values.
  const readCursorJson = (rel, rule) => {
    // Depth first and without recursion: a 20,000-deep array parses fine but would overflow the duplicate-key scan.
    let text = null;
    try { text = read(rel); } catch { /* missing or unreadable: readJson reports it */ }
    if (text !== null && jsonDepth(text) > CURSOR_JSON_MAX_DEPTH) { fail('cursor-json-too-deep', `${rel}: nesting is deeper than ${CURSOR_JSON_MAX_DEPTH} levels`); return null; }
    const value = readJson(rel, rule);
    if (value !== null && text !== null) for (const d of findDuplicateKeys(text)) fail('cursor-json-duplicate-key', `${rel}: duplicate key ${d}`);
    return value;
  };
  // Listing text (what a user reads before installing) must carry no purchase wording: the shared PURCHASE_RE.
  const listingText = [];
  const scanListing = () => {
    for (const [where, text] of listingText) {
      const m = PURCHASE_RE.exec(text);
      if (m) fail('purchase-wording', `${where}: contains purchase wording "${m[0]}"`);
    }
  };

  // Marketplace root: fixes which directory is selected, not only which files are in it.
  let cursorEntryName = null;
  const marketplace = readCursorJson(CURSOR_MARKETPLACE, 'cursor-marketplace');
  if (marketplace !== null) {
    const where = CURSOR_MARKETPLACE;
    if (!isObj(marketplace)) fail('cursor-marketplace', `${where}: must be an object`);
    else {
      exactKeys('cursor-marketplace', where, marketplace, CURSOR_MARKETPLACE_KEYS);
      if ('name' in marketplace && !nonEmpty(marketplace.name)) fail('cursor-marketplace', `${where}: name must be a non-empty string`);
      if ('owner' in marketplace) {
        if (!isObj(marketplace.owner)) fail('cursor-marketplace', `${where}: owner must be an object`);
        else {
          if (!nonEmpty(marketplace.owner.name)) fail('cursor-marketplace', `${where}: owner.name is required`);
          if (!nonEmpty(marketplace.owner.email)) fail('cursor-marketplace', `${where}: owner.email is required`);
        }
      }
      if ('metadata' in marketplace) {
        if (!isObj(marketplace.metadata)) fail('cursor-marketplace', `${where}: metadata must be an object`);
        else {
          if (typeof marketplace.metadata.description === 'string') listingText.push([`${where} metadata.description`, marketplace.metadata.description]);
          // metadata.pluginRoot prefixes every entry's source, so it would redirect the package without touching the entry.
          for (const k of keysOf(marketplace.metadata)) if (!CURSOR_METADATA_KEYS.has(k)) fail('cursor-marketplace', `${where}: unexpected metadata key "${k}" (allowed: ${[...CURSOR_METADATA_KEYS].join(', ')})`);
        }
      }
      if ('plugins' in marketplace) {
        if (!Array.isArray(marketplace.plugins) || marketplace.plugins.length !== 1) fail('cursor-marketplace', `${where}: plugins must hold exactly one entry`);
        else {
          const entry = marketplace.plugins[0];
          if (!isObj(entry)) fail('cursor-marketplace', `${where}: the plugin entry must be an object`);
          else {
            // No marketplace-level override of transport, credentials or component discovery can exist.
            exactKeys('cursor-marketplace-entry', `${where} plugin entry`, entry, CURSOR_ENTRY_KEYS);
            if (entry.source !== CURSOR_MARKETPLACE_SOURCE) fail('cursor-marketplace-entry', `${where} plugin entry: source must be exactly ${CURSOR_MARKETPLACE_SOURCE}, got ${JSON.stringify(entry.source)}`);
            if ('name' in entry && !nonEmpty(entry.name)) fail('cursor-marketplace-entry', `${where} plugin entry: name must be a non-empty string`);
            else if (nonEmpty(entry.name)) cursorEntryName = entry.name;
            if ('description' in entry && !nonEmpty(entry.description)) fail('cursor-marketplace-entry', `${where} plugin entry: description must be a non-empty string`);
            else if (typeof entry.description === 'string') listingText.push([`${where} plugin entry description`, entry.description]);
          }
        }
      }
    }
  }

  // Package file set. The cursor/ tree is walked with NO exclusions (node_modules included; the repository
  // has no .gitignore): cursor/ holds only replylayer, and replylayer holds exactly the package files.
  const cursorRootIsDir = existsSync(p('cursor')) && lstatSync(p('cursor')).isDirectory();
  const cursorEntries = []; // every entry under cursor/, unfiltered
  if (existsSync(p('cursor')) && !cursorRootIsDir) fail('cursor-files', 'cursor: must be a directory, not a file or symlink');
  if (!existsSync(p(CURSOR_PKG))) fail('cursor-files', `${CURSOR_PKG}: missing`);
  if (cursorRootIsDir) {
    const present = new Set();
    const notPart = (rel) => fail('cursor-files', `${rel}: not part of the Cursor package (allowed files: ${CURSOR_FILES.join(', ')})`);
    for (const entry of walkAll(root, 'cursor')) {
      const { rel, isDir, isSymlink } = entry;
      cursorEntries.push(entry);
      if (rel === CURSOR_PKG) { if (!isDir) fail('cursor-files', `${rel}: must be a directory, not a file or symlink`); continue; }
      if (!rel.startsWith(`${CURSOR_PKG}/`)) { fail('cursor-files', `${rel}: cursor/ may hold only replylayer`); continue; }
      const inner = rel.slice(CURSOR_PKG.length + 1);
      if (isDir) { if (!CURSOR_DIRS.has(inner)) notPart(rel); }
      else if (isSymlink || !CURSOR_FILES.includes(inner)) notPart(rel);
      else present.add(inner);
    }
    if (existsSync(p(CURSOR_PKG))) for (const f of CURSOR_FILES) if (!present.has(f)) fail('cursor-files', `${cursorDir(f)}: missing`);
  }

  // Files outside the package: Cursor finds the plugin from the repository root, and its documentation does
  // not settle what happens when other manifests coexist, so no other manifest-shaped file may exist.
  const MANIFEST_NAME_RE = /^(plugin\.json|mcp\.json|\.mcp\.json|marketplace.*\.json)$/i;
  for (const { rel, name, isDir, isSymlink } of walkAll(root, '', ['.git'])) {
    if (!rel.includes('/') && !ROOT_ALLOWLIST.includes(rel)) fail('cursor-root-allowlist', `${rel}: not an allowed top-level entry (allowed: ${ROOT_ALLOWLIST.join(', ')}); add it to ROOT_ALLOWLIST in scripts/validate.mjs in the same PR if it is deliberate`);
    if (rel.startsWith('.github/') && rel.split('/').length === 2 && !GITHUB_ALLOWLIST.includes(name)) fail('cursor-root-allowlist', `${rel}: .github/ may hold only ${GITHUB_ALLOWLIST.join(' and ')}`);
    if (name.toLowerCase() === '.gitmodules') fail('cursor-outside-package', `${rel}: .gitmodules is not allowed (a submodule would pull in code this validator never sees)`);
    if (isDir && name.toLowerCase() === '.cursor') fail('cursor-outside-package', `${rel}: .cursor directories are not allowed`);
    if (!isDir && MANIFEST_NAME_RE.test(name) && !MANIFEST_ALLOWLIST.includes(rel)) fail('cursor-outside-package', `${rel}: plugin.json, mcp.json, .mcp.json and marketplace*.json files are allowed only at ${MANIFEST_ALLOWLIST.join(', ')}`);
    if (rel === '.cursor-plugin' && !isDir) fail('cursor-outside-package', `${rel}: must be a directory holding only marketplace.json`);
    if (rel.startsWith('.cursor-plugin/') && rel !== CURSOR_MARKETPLACE) fail('cursor-outside-package', `${rel}: the root .cursor-plugin/ may hold only marketplace.json`);
    if (rel === CURSOR_MARKETPLACE && (isDir || isSymlink)) fail('cursor-outside-package', `${rel}: must be a regular file`);
  }

  // plugin.json
  const cursorManifest = readCursorJson(cursorDir('.cursor-plugin/plugin.json'), 'cursor-manifest');
  if (cursorManifest !== null) {
    const where = cursorDir('.cursor-plugin/plugin.json');
    if (!isObj(cursorManifest)) fail('cursor-manifest', `${where}: must be an object`);
    else {
      for (const k of keysOf(cursorManifest)) {
        if (CURSOR_COMPONENT_FIELDS.has(k)) fail('cursor-manifest', `${where}: component-path field "${k}" is not allowed`);
        else if (!CURSOR_MANIFEST_KEYS.has(k)) fail('cursor-manifest', `${where}: unexpected key "${k}" (allowed: ${[...CURSOR_MANIFEST_KEYS].join(', ')})`);
      }
      if (cursorEntryName !== null && cursorManifest.name !== cursorEntryName) fail('cursor-manifest', `${where}: name ${JSON.stringify(cursorManifest.name)} must equal the marketplace entry name "${cursorEntryName}"`);
      if (!SEMVER.test(cursorManifest.version ?? '')) fail('cursor-manifest', `${where}: version must be MAJOR.MINOR.PATCH`);
      if (cursorManifest.license !== 'MIT') fail('cursor-manifest', `${where}: license must be "MIT"`);
      if (!isObj(cursorManifest.author) || cursorManifest.author.name !== 'ReplyLayer') fail('cursor-manifest', `${where}: author.name must be "ReplyLayer"`);
      if (!nonEmpty(cursorManifest.description)) fail('cursor-manifest', `${where}: description must be a non-empty string`);
      else listingText.push([`${where} description`, cursorManifest.description]);
      if (Array.isArray(cursorManifest.keywords)) listingText.push([`${where} keywords`, cursorManifest.keywords.filter((k) => typeof k === 'string').join(' ')]);
      if (cursorManifest.homepage !== CURSOR_HOMEPAGE) fail('cursor-manifest', `${where}: homepage must be exactly ${CURSOR_HOMEPAGE}, got ${JSON.stringify(cursorManifest.homepage)}`);
      if (cursorManifest.repository !== CURSOR_REPOSITORY) fail('cursor-manifest', `${where}: repository must be exactly ${CURSOR_REPOSITORY}, got ${JSON.stringify(cursorManifest.repository)}`);

      // Logo: exists, is an .svg, and passes a conservative text check (no script, style import, URL or entity tricks).
      const logo = cursorManifest.logo;
      if (typeof logo !== 'string' || logo === '') fail('cursor-logo', `${where}: logo is required`);
      else if (isAbsolute(logo) || normalize(logo).startsWith('..') || /^[a-z]+:\/\//i.test(logo)) fail('cursor-logo', `${where}: logo must be a relative path inside the package, got ${JSON.stringify(logo)}`);
      else if (!/\.svg$/i.test(logo)) fail('cursor-logo', `${where}: logo must be an .svg file, got ${JSON.stringify(logo)}`);
      else if (!existsSync(p(cursorDir(logo)))) fail('cursor-logo', `${cursorDir(logo)}: logo file missing`);
      else for (const msg of checkLogo(readFileSync(p(cursorDir(logo))))) fail('cursor-logo', `${cursorDir(logo)}: logo ${msg}`);

      // variables: one write-only password field of fixed length, nothing else.
      const vars = cursorManifest.variables;
      const vwhere = `${where} variables`;
      const checkSchema = (node, at) => {
        if (!isObj(node)) return;
        for (const k of keysOf(node)) {
          if (k === 'enum' || k === 'const') fail('cursor-variables', `${at}: schema keyword "${k}" is not allowed`);
          else if (!CURSOR_SCHEMA_KEYWORDS.has(k)) fail('cursor-variables', `${at}: unsupported schema keyword "${k}"`);
        }
        if ('additionalProperties' in node && node.additionalProperties !== false) fail('cursor-variables', `${at}: additionalProperties must be false when present`);
        if (isObj(node.properties)) for (const [n, child] of Object.entries(node.properties)) checkSchema(child, `${at}.properties.${n}`);
        if (isObj(node.items)) checkSchema(node.items, `${at}.items`);
      };
      // A default at any depth, however nested, would put a value where the user's key belongs.
      const noDefaults = (node, at) => {
        if (Array.isArray(node)) node.forEach((v, i) => noDefaults(v, `${at}[${i}]`));
        else if (isObj(node)) for (const [k, v] of Object.entries(node)) {
          if (k === 'default') fail('cursor-variables', `${at}: must not set a default`);
          noDefaults(v, `${at}.${k}`);
        }
      };
      if (!isObj(vars)) fail('cursor-variables', `${vwhere}: required, must be an object`);
      else {
        checkSchema(vars, vwhere);
        noDefaults(vars, vwhere);
        if (vars.type !== 'object') fail('cursor-variables', `${vwhere}: type must be "object"`);
        const props = isObj(vars.properties) ? vars.properties : {};
        if (!isObj(vars.properties) || keysOf(props).length !== 1 || !(CURSOR_KEY_VAR in props)) fail('cursor-variables', `${vwhere}: properties must be exactly ${CURSOR_KEY_VAR}, got ${JSON.stringify(keysOf(props))}`);
        if (!Array.isArray(vars.required) || vars.required.length !== 1 || vars.required[0] !== CURSOR_KEY_VAR) fail('cursor-variables', `${vwhere}: required must be exactly ["${CURSOR_KEY_VAR}"]`);
        const prop = props[CURSOR_KEY_VAR];
        if (isObj(prop)) {
          const at = `${vwhere}.${CURSOR_KEY_VAR}`;
          if (prop.type !== 'string') fail('cursor-variables', `${at}: type must be "string"`);
          if (prop.format !== 'password') fail('cursor-variables', `${at}: format must be "password"`);
          if (prop.writeOnly !== true) fail('cursor-variables', `${at}: writeOnly must be true`);
          if (prop.minLength !== CURSOR_KEY_LENGTH) fail('cursor-variables', `${at}: minLength must be ${CURSOR_KEY_LENGTH}`);
          if (prop.maxLength !== CURSOR_KEY_LENGTH) fail('cursor-variables', `${at}: maxLength must be ${CURSOR_KEY_LENGTH}`);
          for (const field of ['title', 'description']) {
            if (!nonEmpty(prop[field])) fail('cursor-variables', `${at}: ${field} must be a non-empty string`);
            else listingText.push([`${at} ${field}`, prop[field]]);
          }
        } else if (CURSOR_KEY_VAR in props) fail('cursor-variables', `${vwhere}.${CURSOR_KEY_VAR}: must be an object`);
      }
    }
  }

  // mcp.json: deep-equal to the one allowed config, with a specific message for each way to differ.
  const cursorMcp = readCursorJson(cursorDir('mcp.json'), 'cursor-mcp');
  if (cursorMcp !== null) for (const msg of cursorMcpProblems(cursorMcp)) fail('cursor-mcp', `${cursorDir('mcp.json')}: ${msg}`);

  // Skill: hand-maintained, so it is parsed here and never compared with skills/. It gets every shared skill
  // safety rule (skill-lines, claude-wording, skill-url, hidden-content, hidden-tool, unknown-tool,
  // purchase-wording) through the same helper the shared skills use. Not applied, and why:
  //   - skills-tokens and the 1-5 skill count: a budget and a cap on the shared skills/ set that OpenAI imports; this skill is not part of it.
  //   - skill-drift: the Cursor skill is outside the sync, so there is no source copy to compare with.
  //   - the `license` frontmatter field: the shared copies carry it; this package's LICENSE file is checked instead, so only name and description are allowed.
  // hidden-tool still names the tools missing from the sign-in grant: those tools are not for this skill either (agent keys cannot approve or deny holds).
  const cursorSkillRel = cursorDir('skills/replylayer-email/SKILL.md');
  if (existsSync(p(cursorSkillRel))) {
    const skillText = read(cursorSkillRel);
    const fm = parseFrontmatter(skillText);
    if (fm.error) fail('cursor-skill', `${cursorSkillRel}: ${fm.error}`);
    else {
      for (const k of fm.keys) if (!CURSOR_SKILL_FIELDS.has(k)) fail('cursor-skill', `${cursorSkillRel}: unsupported frontmatter field "${k}" (allowed: ${[...CURSOR_SKILL_FIELDS].join(', ')})`);
      if (!nonEmpty(fm.data.name)) fail('cursor-skill', `${cursorSkillRel}: name is required`);
      else {
        if (fm.data.name !== 'replylayer-email') fail('cursor-skill', `${cursorSkillRel}: name "${fm.data.name}" must equal its folder "replylayer-email"`);
        if (!KEBAB.test(fm.data.name)) fail('cursor-skill', `${cursorSkillRel}: name must be kebab-case`);
      }
      if (!nonEmpty(fm.data.description)) fail('cursor-skill', `${cursorSkillRel}: description is required`);
      else if (fm.data.description.length > DESCRIPTION_MAX) fail('cursor-skill', `${cursorSkillRel}: description is ${fm.data.description.length} characters, limit ${DESCRIPTION_MAX}`);
      if (fm.body.trim() === '') fail('cursor-skill', `${cursorSkillRel}: empty body`);
    }
    checkSkillText(cursorSkillRel, skillText, fail);
    const purchase = PURCHASE_RE.exec(skillText);
    if (purchase) fail('purchase-wording', `${cursorSkillRel}: contains purchase wording "${purchase[0]}"`);
    // Cursor-only extras. Markdown comments and link forms without "http" slip past the shared checks.
    if (/\[\/\/\]\s*:/.test(skillText)) fail('hidden-content', `${cursorSkillRel}: [//]: markdown comments can hide instructions`);
    if (/(?<![:A-Za-z0-9])\/\/[A-Za-z0-9]|\bwww\.|\b(?:ftp|javascript|mailto):/i.test(skillText)) fail('skill-url', `${cursorSkillRel}: skills must not contain link forms (//host, www., ftp:, javascript:, mailto:)`);
    // A double-quoted frontmatter value may spell a tool name or a hidden character with YAML escapes (approve\x5Freview).
    const fmRaw = skillText.replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
    if (fmRaw) {
      const decoded = [];
      for (const line of fmRaw[1].split('\n')) {
        const m = /^[A-Za-z_][A-Za-z0-9_-]*:\s+"(.*)"\s*$/.exec(line);
        if (m) decoded.push(decodeYamlDouble(m[1]));
      }
      if (decoded.length > 0) {
        const text = decoded.join('\n');
        checkToolNames(`${cursorSkillRel} (decoded frontmatter)`, text, fail);
        if (INVISIBLE_RE.test(text) || CURSOR_HIDDEN_RE.test(text)) fail('hidden-content', `${cursorSkillRel}: a frontmatter escape decodes to an invisible character`);
      }
      // Frontmatter is plain `key: value` lines: no quoting (so no escapes to decode), no block scalars, no
      // continuation lines, no comments. A value that merely decodes to a tool name is also refused above.
      for (const line of fmRaw[1].split('\n')) {
        if (line.trim() === '') continue;
        if (!/^[A-Za-z_][A-Za-z0-9_-]*:[ \t]+[^\s"'#|>\\][^#|>\\]*$/.test(line)) fail('cursor-skill-frontmatter', `${cursorSkillRel}: frontmatter line ${JSON.stringify(line.slice(0, 60))} must be "key: value" with a plain unquoted value (no leading quote, no backslash, #, | or >, no continuation line)`);
      }
      // No mention of the tool at all in frontmatter, raw or decoded.
      if (mentionLines([fmRaw[1], ...decoded].join('\n')).length > 0) fail('cursor-skill-frontmatter', `${cursorSkillRel}: frontmatter must not mention add_recipient or attest (raw or decoded)`);
    }
    // The add_recipient / attest ban is pinned (see CURSOR_SKILL_RULE1).
    const norm = skillText.replace(/\r\n/g, '\n');
    const h1 = norm.search(/^## 1\./m);
    const h2 = norm.search(/^## 2\./m);
    if (h1 < 0 || h2 < h1) fail('cursor-skill-pinned', `${cursorSkillRel}: rule 1 heading ("## 1.") and the next heading ("## 2.") must both be present, in order`);
    else if (norm.slice(h1, h2) !== CURSOR_SKILL_RULE1) fail('cursor-skill-pinned', `${cursorSkillRel}: rule 1 differs from the pinned text (the API key stays out of chat)`);
    const rawLines = norm.split('\n');
    const pinnedLines = new Set(CURSOR_SKILL_PINNED_LINES);
    for (const line of CURSOR_SKILL_PINNED_LINES) if (!rawLines.includes(line)) fail('cursor-skill-pinned', `${cursorSkillRel}: missing the pinned line ${JSON.stringify(line.slice(0, 60))}... (it must appear whole and unchanged)`);
    for (const i of mentionLines(norm)) if (!pinnedLines.has(rawLines[i])) fail('cursor-skill-pinned', `${cursorSkillRel}:${i + 1}: mentions add_recipient or attest but is not one of the two pinned lines`);
    // Rule 1 and the pinned lines must be live text: a fence or blockquote can turn them into an example.
    const covered = fencedOrQuotedLines(rawLines);
    const rule1At = rawLines.findIndex((l) => /^## 1\./.test(l));
    const rule2At = rawLines.findIndex((l) => /^## 2\./.test(l));
    const mustBeLive = new Set(rawLines.flatMap((l, i) => (pinnedLines.has(l) || (rule1At >= 0 && i >= rule1At && i < rule2At) ? [i] : [])));
    for (const i of mustBeLive) if (covered[i]) { fail('cursor-skill-pinned', `${cursorSkillRel}:${i + 1}: rule 1 and the pinned lines must not sit inside a code fence or a blockquote`); break; }
    // Only Basic Latin letters: a look-alike letter from another script spells a tool name no check above reads.
    const foreign = [...new Set([...skillText].filter((c) => c.codePointAt(0) > 0x7f && /[\p{L}\p{M}]/u.test(c)))];
    if (foreign.length > 0) fail('cursor-skill-latin', `${cursorSkillRel}: contains letters outside Basic Latin: ${foreign.map((c) => `U+${c.codePointAt(0).toString(16).toUpperCase().padStart(4, '0')}`).join(', ')}`);
    // Character allowlist: these characters are what Markdown, HTML and YAML use to hide, reshape or re-render text
    // (a `< n ... n >` span that a tag stripper removes but a renderer shows, `[a](#)_b` link splits, `<del>`
    // wrappers, table rows, backslash escapes, code fences). The shipped skill uses none of them.
    const charRules = [[/</, '"<"'], [/>/, '">"'], [/\[/, '"["'], [/\]/, '"]"'], [/\\/, '"\\"'], [/\|/, '"|"'], [/~~/, '"~~"'], [/^[ \t]*(`{3,}|~{3,})/, 'a code-fence marker']];
    for (const [re, label] of charRules) {
      const at = rawLines.findIndex((l) => re.test(l));
      if (at >= 0) fail('cursor-skill-chars', `${cursorSkillRel}:${at + 1}: contains ${label}, which this skill does not allow`);
    }
    // Link-reference definitions and angle-bracket autolinks are links the plain-text rules above do not see.
    if (/^\s*\[[^\]]+\]:\s/m.test(skillText)) fail('skill-url', `${cursorSkillRel}: skills must not contain link reference definitions ([label]: target)`);
    if (/<[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+[^<>\s]*>|<[A-Za-z][A-Za-z0-9+.-]*:[^<>\s]*>/.test(skillText)) fail('skill-url', `${cursorSkillRel}: skills must not contain angle-bracket autolinks`);
  } else if (existsSync(p(CURSOR_PKG))) fail('cursor-skill', `${cursorSkillRel}: missing`);

  // README and LICENSE
  const cursorReadme = cursorDir('README.md');
  if (existsSync(p(cursorReadme))) {
    const words = countWords(read(cursorReadme));
    if (words < README_MIN_WORDS) fail('cursor-package', `${cursorReadme}: ${words} words outside code blocks, need at least ${README_MIN_WORDS}`);
    listingText.push([cursorReadme, read(cursorReadme)]);
  }
  scanListing();
  const cursorLicense = cursorDir('LICENSE');
  if (existsSync(p(cursorLicense)) && !/^MIT License/.test(read(cursorLicense))) fail('cursor-package', `${cursorLicense}: must be the MIT license`);

  // Content pin (option B): every shipped file is pinned by the SHA-256 of its raw bytes. Any change, missing file or
  // unpinned extra file fails, naming the file and printing the actual hash; a deliberate change edits the pin.
  {
    const actual = cursorContentHashes(root);
    for (const rel of Object.keys(CURSOR_CONTENT_PINS)) {
      if (!(rel in actual)) fail('cursor-content-pin', `${rel}: pinned file is missing`);
      else if (actual[rel] !== CURSOR_CONTENT_PINS[rel]) fail('cursor-content-pin', `${rel}: content differs from its pin (actual sha256 ${actual[rel]}; edit CURSOR_CONTENT_PINS in scripts/validate.mjs in the same PR if the change is deliberate)`);
    }
    for (const rel of Object.keys(actual)) if (!(rel in CURSOR_CONTENT_PINS)) fail('cursor-content-pin', `${rel}: file has no pin (actual sha256 ${actual[rel]})`);
  }

  // Key-shaped strings and hidden characters anywhere under cursor/ (unfiltered, so node_modules is covered
  // too; the shared file-hygiene pass above skips it) and in the marketplace file.
  const cursorTexts = [CURSOR_MARKETPLACE, ...cursorEntries.filter((e) => !e.isDir && !e.isSymlink).map((e) => e.rel)];
  for (const rel of cursorTexts) {
    if (!existsSync(p(rel)) || lstatSync(p(rel)).isSymbolicLink()) continue;
    let text = null;
    try { text = decoder.decode(readFileSync(p(rel))); } catch { /* binary: reported by cursor-files */ }
    if (text === null) continue;
    if (KEY_SHAPED.test(text)) fail('cursor-key-shaped', `${rel}: contains a key-shaped rly_live_ string`);
    if (INVISIBLE_RE.test(text)) fail('cursor-hidden-content', `${rel}: contains invisible or bidirectional-control characters`);
    if (CURSOR_HIDDEN_RE.test(text)) fail('cursor-hidden-content', `${rel}: ${CURSOR_HIDDEN_MESSAGE}`);
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
  if (args.includes('--print-cursor-hashes')) {
    process.stdout.write(formatCursorPins(cursorContentHashes(root)));
    process.exit(0);
  }
  const mcpUrl = flag('--url') ?? process.env.REPLYLAYER_EXPECTED_MCP_URL ?? PRODUCTION_MCP_URL;
  const errors = validate(root, { mcpUrl, runClaude: !args.includes('--no-claude') });
  if (errors.length > 0) {
    for (const e of errors) console.error(`FAIL ${e}`);
    process.exit(1);
  }
  console.log(`OK: manifests, MCP URL (${mcpUrl}), skills, copies and file hygiene all valid`);
}
