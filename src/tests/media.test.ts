import { describe, it, before, after, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  audioFormatFromExtension,
  createBase64DataUrl,
  createRawBase64,
  parseAllowedMediaRoots,
  resolveAllowedMediaRoots,
  validateMediaFile
} from '../services/media.js';
import type { MediaKind, RecognitionProviderName } from '../types/index.js';

interface SupportedCase {
  provider: RecognitionProviderName;
  mediaKind: MediaKind;
  extension: string;
  mimeType: string;
}

let tmpDir: string;
let allowedRoot: string;
let outsideRoot: string;
let originalAllowedMediaRoots: string | undefined;
let originalMediaRoots: string | undefined;

before(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'media-service-test-'));
  allowedRoot = path.join(tmpDir, 'allowed');
  outsideRoot = path.join(tmpDir, 'outside');
  fs.mkdirSync(allowedRoot);
  fs.mkdirSync(outsideRoot);
  originalAllowedMediaRoots = process.env.ALLOWED_MEDIA_ROOTS;
  originalMediaRoots = process.env.MEDIA_ROOTS;
  clearMediaRootEnv();
});

afterEach(() => {
  clearMediaRootEnv();
});

after(() => {
  restoreMediaRootEnv();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('media format validation', () => {
  const supportedCases: SupportedCase[] = [
    { provider: 'gemini', mediaKind: 'image', extension: '.jpg', mimeType: 'image/jpeg' },
    { provider: 'gemini', mediaKind: 'image', extension: '.jpeg', mimeType: 'image/jpeg' },
    { provider: 'gemini', mediaKind: 'image', extension: '.png', mimeType: 'image/png' },
    { provider: 'gemini', mediaKind: 'image', extension: '.webp', mimeType: 'image/webp' },
    { provider: 'gemini', mediaKind: 'audio', extension: '.mp3', mimeType: 'audio/mp3' },
    { provider: 'gemini', mediaKind: 'audio', extension: '.wav', mimeType: 'audio/wav' },
    { provider: 'gemini', mediaKind: 'audio', extension: '.ogg', mimeType: 'audio/ogg' },
    { provider: 'gemini', mediaKind: 'video', extension: '.mp4', mimeType: 'video/mp4' },
    { provider: 'openai-compatible', mediaKind: 'image', extension: '.jpg', mimeType: 'image/jpeg' },
    { provider: 'openai-compatible', mediaKind: 'image', extension: '.jpeg', mimeType: 'image/jpeg' },
    { provider: 'openai-compatible', mediaKind: 'image', extension: '.png', mimeType: 'image/png' },
    { provider: 'openai-compatible', mediaKind: 'image', extension: '.webp', mimeType: 'image/webp' },
    { provider: 'openai-compatible', mediaKind: 'audio', extension: '.mp3', mimeType: 'audio/mp3' },
    { provider: 'openai-compatible', mediaKind: 'audio', extension: '.wav', mimeType: 'audio/wav' },
    { provider: 'openai-compatible', mediaKind: 'video', extension: '.mp4', mimeType: 'video/mp4' },
    { provider: 'openai-compatible', mediaKind: 'video', extension: '.mpeg', mimeType: 'video/mpeg' },
    { provider: 'openai-compatible', mediaKind: 'video', extension: '.mov', mimeType: 'video/mov' },
    { provider: 'openai-compatible', mediaKind: 'video', extension: '.avi', mimeType: 'video/x-msvideo' },
    { provider: 'openai-compatible', mediaKind: 'video', extension: '.webm', mimeType: 'video/webm' }
  ];

  for (const testCase of supportedCases) {
    it(`returns ${testCase.mimeType} for ${testCase.provider} ${testCase.mediaKind} ${testCase.extension}`, async () => {
      const filepath = createTempFile(`supported-${testCase.provider}-${testCase.mediaKind}${testCase.extension}`);

      const details = await validateMediaFile('Test Provider', testCase.provider, testCase.mediaKind, filepath);

      assert.strictEqual(details.filepath, filepath);
      assert.strictEqual(details.extension, testCase.extension);
      assert.strictEqual(details.mimeType, testCase.mimeType);
      assert.strictEqual(details.sizeBytes, 4);
    });
  }

  it('rejects unsupported formats without echoing the full path', async () => {
    const filepath = createTempFile('unsupported-format.txt');

    await assert.rejects(
      () => validateMediaFile('Test Provider', 'gemini', 'image', filepath),
      (error: unknown) => {
        assertErrorMessage(error, /Unsupported image format/);
        assertErrorDoesNotIncludePath(error, filepath);
        assert.match(errorMessage(error), /\.txt/);
        return true;
      }
    );
  });

  it('rejects missing files without echoing the full path', async () => {
    const filepath = path.join(tmpDir, 'missing-file.png');

    await assert.rejects(
      () => validateMediaFile('Test Provider', 'gemini', 'image', filepath),
      (error: unknown) => {
        assertErrorMessage(error, /Image file not found: missing-file\.png/);
        assertErrorDoesNotIncludePath(error, filepath);
        return true;
      }
    );
  });

  it('rejects directories without echoing the full path', async () => {
    const directoryPath = path.join(tmpDir, 'not-a-file.png');
    fs.mkdirSync(directoryPath);

    await assert.rejects(
      () => validateMediaFile('Test Provider', 'gemini', 'image', directoryPath),
      (error: unknown) => {
        assertErrorMessage(error, /Image path is not a file: not-a-file\.png/);
        assertErrorDoesNotIncludePath(error, directoryPath);
        return true;
      }
    );
  });
});

describe('inline media encoding guards', () => {
  it('rejects oversized data URLs before reading file content', async () => {
    const filepath = createTempFile('oversized-data-url.png');

    await assert.rejects(
      () => createBase64DataUrl({ filepath, extension: '.png', mimeType: 'image/png', sizeBytes: 2 }, 1),
      /Inline media file is too large: 2 bytes/
    );
  });

  it('rejects oversized raw base64 before reading file content', async () => {
    const filepath = createTempFile('oversized-raw-audio.wav');

    await assert.rejects(
      () => createRawBase64({ filepath, extension: '.wav', mimeType: 'audio/wav', sizeBytes: 2 }, 1),
      /Inline media file is too large: 2 bytes/
    );
  });

  it('converts audio extensions to provider format strings', () => {
    assert.strictEqual(audioFormatFromExtension('.wav'), 'wav');
    assert.strictEqual(audioFormatFromExtension('mp3'), 'mp3');
  });
});

describe('allowed media roots', () => {
  it('parses root lists with the platform path delimiter', () => {
    const first = path.join(tmpDir, 'first');
    const second = path.join(tmpDir, 'second');

    assert.deepStrictEqual(parseAllowedMediaRoots(` ${first} ${path.delimiter} ${second} `), [first, second]);
    assert.deepStrictEqual(parseAllowedMediaRoots(undefined), []);
    assert.deepStrictEqual(parseAllowedMediaRoots('   '), []);
  });

  it('resolves ALLOWED_MEDIA_ROOTS and MEDIA_ROOTS aliases and rejects ambiguity', async () => {
    assert.deepStrictEqual(await resolveAllowedMediaRoots({ ALLOWED_MEDIA_ROOTS: allowedRoot }), [fs.realpathSync(allowedRoot)]);
    assert.deepStrictEqual(await resolveAllowedMediaRoots({ MEDIA_ROOTS: allowedRoot }), [fs.realpathSync(allowedRoot)]);

    await assert.rejects(
      () => resolveAllowedMediaRoots({ ALLOWED_MEDIA_ROOTS: allowedRoot, MEDIA_ROOTS: outsideRoot }),
      /both ALLOWED_MEDIA_ROOTS and MEDIA_ROOTS are set/
    );
  });

  it('allows files under ALLOWED_MEDIA_ROOTS', async () => {
    process.env.ALLOWED_MEDIA_ROOTS = allowedRoot;
    delete process.env.MEDIA_ROOTS;
    const filepath = createTempFile('allowed-image.png', allowedRoot);

    const details = await validateMediaFile('Test Provider', 'gemini', 'image', filepath);

    assert.strictEqual(details.filepath, filepath);
    assert.strictEqual(details.mimeType, 'image/png');
  });

  it('rejects files outside ALLOWED_MEDIA_ROOTS without echoing the full path', async () => {
    process.env.ALLOWED_MEDIA_ROOTS = allowedRoot;
    delete process.env.MEDIA_ROOTS;
    const filepath = createTempFile('outside-image.png', outsideRoot);

    await assert.rejects(
      () => validateMediaFile('Test Provider', 'gemini', 'image', filepath),
      (error: unknown) => {
        assertErrorMessage(error, /Image file is outside configured media roots: outside-image\.png/);
        assertErrorDoesNotIncludePath(error, filepath);
        return true;
      }
    );
  });

  it('rejects symlink escapes from configured media roots when symlinks are available', async (t) => {
    const outsideFile = createTempFile('outside-symlink-target.png', outsideRoot);
    const linkPath = path.join(allowedRoot, 'escape-link.png');

    try {
      fs.symlinkSync(outsideFile, linkPath, 'file');
    } catch (error) {
      t.skip(`Symlink creation unavailable on this platform: ${errorMessage(error)}`);
      return;
    }

    process.env.ALLOWED_MEDIA_ROOTS = allowedRoot;
    delete process.env.MEDIA_ROOTS;

    await assert.rejects(
      () => validateMediaFile('Test Provider', 'gemini', 'image', linkPath),
      (error: unknown) => {
        assertErrorMessage(error, /Image file is outside configured media roots: escape-link\.png/);
        assertErrorDoesNotIncludePath(error, linkPath);
        assertErrorDoesNotIncludePath(error, outsideFile);
        return true;
      }
    );
  });
});

function createTempFile(filename: string, directory = tmpDir): string {
  const filepath = path.join(directory, filename);
  fs.writeFileSync(filepath, Buffer.from('test'));
  return filepath;
}

function restoreMediaRootEnv(): void {
  restoreEnvValue('ALLOWED_MEDIA_ROOTS', originalAllowedMediaRoots);
  restoreEnvValue('MEDIA_ROOTS', originalMediaRoots);
}

function clearMediaRootEnv(): void {
  delete process.env.ALLOWED_MEDIA_ROOTS;
  delete process.env.MEDIA_ROOTS;
}

function restoreEnvValue(name: 'ALLOWED_MEDIA_ROOTS' | 'MEDIA_ROOTS', value: string | undefined): void {
  if (value === undefined) {
    if (name === 'ALLOWED_MEDIA_ROOTS') {
      delete process.env.ALLOWED_MEDIA_ROOTS;
    } else {
      delete process.env.MEDIA_ROOTS;
    }
    return;
  }

  process.env[name] = value;
}

function assertErrorMessage(error: unknown, pattern: RegExp): void {
  assert.match(errorMessage(error), pattern);
}

function assertErrorDoesNotIncludePath(error: unknown, filepath: string): void {
  assert.ok(!errorMessage(error).includes(filepath), `Expected error not to include full path ${filepath}`);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
