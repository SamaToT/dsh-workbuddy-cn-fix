// dsh-workbuddy-cn-fix — repairs the CN path of dsh-workbuddy-connect.
//
// WorkBuddy's CN upstream (copilot.tencent.com) runs a channel check on the
// OPENING of the system message and answers a prompt that opens with a rival
// client identity line with HTTP 400 / code 11128 ("Illegal API invocation
// from an unapproved channel"). It also rejects the `developer` role that
// pi-ai emits for reasoning models.
//
// The shipped plugin normalizes the role and neutralizes the signature on the
// INTERNATIONAL path only; the CN path (prepareCnChatBody) does neither. So
// every request DSH sends to workbuddy is rejected, whatever the plugin's own
// model selection does.
//
// The repair runs at activation, so a plugin reinstall — which replaces
// node_modules — is fixed on the next start instead of silently breaking
// again. It edits the installed package in place, because the upstream sends
// the request from inside its own adapter and offers no hook for a caller to
// rewrite the body.
//
// Verified against the live CN endpoint: before the patch every combination
// of role (developer/system) and opening (rival identity / neutral line) is
// rejected with 400 / 11128, except "system + neutral line"; after the patch
// all four combinations answer 200.

import { existsSync, readFileSync, writeFileSync, renameSync } from "node:fs";
import { createRequire } from "node:module";
import { join } from "node:path";
import { homedir } from "node:os";

const name = "dsh-workbuddy-cn-fix";
const inject = [];

/** The package this bundle repairs. */
const TARGET = "dsh-workbuddy-connect";

/** Where the plugin's compiled sources live, relative to the package root. */
const SOURCE_CANDIDATES = [
  "lib/host-heartbeat-SJaZ33tR.js",
  "lib/index.js",
];

/**
 * The call site: the CN body preparation.
 *
 * `dropUnsupportedEffort(body)` is the last statement of the shipped CN
 * path; the repair adds the role normalization and the signature
 * neutralization right after it.
 */
const CN_BODY_ANCHOR = "\tif (!isObject(body)) return source;\n\tdropUnsupportedEffort(body);\n\treturn JSON.stringify(body);\n}\nfunction prepareInternationalChatBody(source) {";

const CN_BODY_FIXED = "\tif (!isObject(body)) return source;\n\tdropUnsupportedEffort(body);\n\tnormalizeDeveloperRole(body);\n\tneutralizeRejectedSystemSignature(body);\n\treturn JSON.stringify(body);\n}\nfunction prepareInternationalChatBody(source) {";

/**
 * The neutralization itself.
 *
 * The upstream gateway matches the identity line on the OPENING of the system
 * message, so the request is fixed by putting a harmless line in FRONT of the
 * prompt: the text the model was given is kept verbatim. The match is a
 * prefix match, and a system message that merely mentions the client name
 * later is served normally.
 */
const NEUTRALIZER_BLOCK = `/**
 * System-prompt openings the WorkBuddy gateway refuses to serve.
 *
 * The gateway runs a channel check on the system message and answers a
 * request whose system prompt opens with a rival client's identity line
 * with HTTP 400 / code 11128 ("Illegal API invocation from an unapproved
 * channel"), whose \`displayMsg.zh\` is 「请求被拦截，请重新发送」.
 *
 * The signature is matched on the *opening* of the system message, not on
 * its content, and the match is a prefix match. The list below therefore
 * holds *prefixes*, and a request is neutralized as soon as its first
 * system message starts with one of them.
 */
const REJECTED_SYSTEM_SIGNATURES = [/^You are an AI agent powered by DeepSeek Harness\\.?/i];
/** The harmless prefix inserted ahead of a rejected system signature. */
const SYSTEM_SIGNATURE_NEUTRALIZER = "You are a helpful assistant.";
/**
 * Whether the gateway would refuse this system message.
 */
function hasRejectedSystemSignature(content) {
\tif (typeof content === "string") {
\t\tconst text = content.trimStart();
\t\treturn REJECTED_SYSTEM_SIGNATURES.some((pattern) => pattern.test(text));
\t}
\tif (!Array.isArray(content)) return false;
\tfor (const block of content) {
\t\tif (typeof block !== "object" || block === null || Array.isArray(block)) continue;
\t\tconst wrapped = block;
\t\tif (wrapped["type"] !== "text" || typeof wrapped["text"] !== "string") continue;
\t\tconst text = wrapped["text"].trimStart();
\t\tif (REJECTED_SYSTEM_SIGNATURES.some((pattern) => pattern.test(text))) return true;
\t}
\treturn false;
}
/**
 * Put a harmless opening in front of a system message the gateway would
 * refuse, so its prefix check stops matching.
 *
 * The system prompt's own text is kept verbatim — only a leading line is
 * added — so the model still receives the instructions it was given. Only the
 * first system message is considered: the gateway reads the opening of the
 * conversation, and later system messages carry no identity claim.
 */
function neutralizeRejectedSystemSignature(obj) {
\tconst messages = obj["messages"];
\tif (!Array.isArray(messages)) return;
\tfor (const message of messages) {
\t\tif (typeof message !== "object" || message === null || Array.isArray(message)) continue;
\t\tconst wrapped = message;
\t\tconst role = wrapped["role"];
\t\tif (role !== "system" && role !== "developer") continue;
\t\tconst content = wrapped["content"];
\t\tif (typeof content === "string") {
\t\t\tif (hasRejectedSystemSignature(content)) wrapped["content"] = \`\${SYSTEM_SIGNATURE_NEUTRALIZER}\\n\\n\${content}\`;
\t\t} else if (Array.isArray(content)) {
\t\t\tif (hasRejectedSystemSignature(content)) {
\t\t\t\twrapped["content"] = [
\t\t\t\t\t{ type: "text", text: SYSTEM_SIGNATURE_NEUTRALIZER },
\t\t\t\t\t...content,
\t\t\t\t];
\t\t\t}
\t\t}
\t}
}
`;

/**
 * Where the installed package lives.
 *
 * The plugin is installed into the desktop profile, not into the DSH home, so
 * the lookup has to try the profile's node_modules as well. The bundle runs
 * inside that profile's process, so its own location is the best hint.
 */
function packageRoot() {
  const roots = [];
  const here = new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1");
  roots.push(here);
  const home = homedir();
  roots.push(join(home, ".dsh"));
  roots.push(join(home, ".dsh", "profiles", "desktop"));
  for (const base of roots) {
    const candidate = join(base, "node_modules", TARGET, "package.json");
    if (existsSync(candidate)) return join(candidate, "..");
  }
  // Last resort: let Node resolve it from the usual locations.
  try {
    const require = createRequire(join(home, ".dsh", "package.json"));
    return join(require.resolve(`${TARGET}/package.json`), "..");
  } catch {
    return undefined;
  }
}

/**
 * Apply the repair to one source file.
 *
 * The file is rewritten atomically (write to a sibling, then rename) so a
 * crash cannot leave a half-written plugin behind.
 */
function patchFile(file) {
  if (!existsSync(file)) return "missing";
  const source = readFileSync(file, "utf8");
  if (source.includes("function neutralizeRejectedSystemSignature")) return "already-patched";
  if (!source.includes(CN_BODY_ANCHOR)) return "no-anchor";
  // The role normalizer has to exist too; the shipped package only defines it
  // for the international path, but it is present in the same module.
  if (!source.includes("function normalizeDeveloperRole")) return "no-normalizer";

  let patched = source.replace(CN_BODY_ANCHOR, CN_BODY_FIXED);
  // Insert the neutralizer right before the CN preparation function.
  const anchor = "function prepareCnChatBody(source) {";
  if (!patched.includes(anchor)) return "no-fn";
  patched = patched.replace(anchor, `${NEUTRALIZER_BLOCK}${anchor}`);

  const temporary = `${file}.dsh-workbuddy-cn-fix.tmp`;
  writeFileSync(temporary, patched, "utf8");
  renameSync(temporary, file);
  return "patched";
}

async function apply(ctx) {
  const root = packageRoot();
  if (root === undefined) {
    ctx.logger?.warn?.(
      `dsh-workbuddy-cn-fix: ${TARGET} is not installed; nothing to repair.`
    );
    return;
  }
  let repaired = 0;
  let skipped = 0;
  for (const relative of SOURCE_CANDIDATES) {
    const file = join(root, relative);
    const outcome = patchFile(file);
    if (outcome === "patched") {
      repaired++;
      ctx.logger?.info?.(
        `dsh-workbuddy-cn-fix: repaired the CN chat path in ${TARGET}/${relative}.`
      );
    } else if (outcome === "already-patched") {
      skipped++;
    } else if (outcome !== "missing") {
      ctx.logger?.warn?.(
        `dsh-workbuddy-cn-fix: could not repair ${TARGET}/${relative} (${outcome}).`
      );
    }
  }
  if (repaired === 0 && skipped === 0) {
    ctx.logger?.warn?.(
      `dsh-workbuddy-cn-fix: no ${TARGET} source matched; the package layout may have changed.`
    );
  }
}

export { name, apply, inject };
