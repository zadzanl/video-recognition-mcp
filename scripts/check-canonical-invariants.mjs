/**
 * status: active
 * phase: change-b-group-7-documentation-and-verification
 * sprint: gemini-model-fallback-and-rate-limit-recovery
 * last_modified: 2026-08-08
 * agent_notes: "Checks locked cross-file invariant sentences without dependencies or source mutation."
 * insights: "The manifest enforces exact declaring-file occurrence counts; --root exists only for isolated fixture tests."
 */

import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const changeRoot = 'openspec/changes/add-gemini-model-fallback-and-rate-limit-recovery';
const files = {
  design: `${changeRoot}/design.md`,
  tasks: `${changeRoot}/tasks.md`,
  geminiSpec: `${changeRoot}/specs/gemini-model-fallback/spec.md`,
  rateLimitSpec: `${changeRoot}/specs/rate-limit-recovery-routing/spec.md`
};

const invariants = [
  {
    label: 'terminal-cap',
    text: 'without splitting a code point or escape sequence',
    counts: { design: 1, tasks: 1, geminiSpec: 0, rateLimitSpec: 1 }
  },
  {
    label: 'backup-fail-fast-final',
    text: 'permission, HTTP 403, billing, unsupported-media, safety, invalid-request, malformed-response, and unknown',
    counts: { design: 1, tasks: 2, geminiSpec: 0, rateLimitSpec: 2 }
  },
  {
    label: 'redaction-inventory',
    text: 'credentials or API keys, authorization headers, data URLs, prompts, paths, file contents, encoded media, or complete or upstream provider bodies',
    counts: { design: 0, tasks: 2, geminiSpec: 0, rateLimitSpec: 1 }
  },
  {
    label: 'http-403-rule',
    text: 'HTTP 403 is unconditionally fail-fast',
    counts: { design: 1, tasks: 1, geminiSpec: 0, rateLimitSpec: 0 }
  }
];

const parseRoot = (args) => {
  if (args.length === 0) {
    const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
    return path.resolve(scriptDirectory, '..', '..');
  }
  if (args.length === 2 && args[0] === '--root' && args[1].length > 0) {
    return path.resolve(args[1]);
  }
  throw new Error('usage: check-canonical-invariants.mjs [--root <workspace-root>]');
};

const countOccurrences = (content, needle) => {
  let count = 0;
  let offset = 0;
  while (true) {
    const match = content.indexOf(needle, offset);
    if (match === -1) return count;
    count += 1;
    offset = match + needle.length;
  }
};

const check = async (root) => {
  const contents = {};
  let failed = false;

  for (const [key, relativePath] of Object.entries(files)) {
    try {
      contents[key] = await readFile(path.join(root, relativePath), 'utf8');
    } catch {
      failed = true;
      console.error(`canonical-invariant file=${relativePath} reason=unreadable`);
    }
  }

  for (const invariant of invariants) {
    for (const [key, expected] of Object.entries(invariant.counts)) {
      const content = contents[key];
      if (content === undefined) continue;
      const actual = countOccurrences(content, invariant.text);
      if (actual !== expected) {
        failed = true;
        console.error(
          `canonical-invariant label=${invariant.label} file=${files[key]} expected=${expected} actual=${actual} reason=count-mismatch`
        );
      }
    }
  }

  if (failed) return 1;
  console.log('Canonical invariant check passed.');
  return 0;
};

try {
  process.exitCode = await check(parseRoot(process.argv.slice(2)));
} catch (error) {
  const reason = error instanceof Error ? error.message : 'unexpected failure';
  console.error(`canonical-invariant reason=${reason}`);
  process.exitCode = 1;
}