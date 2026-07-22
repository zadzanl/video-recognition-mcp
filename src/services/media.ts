/**
 * Provider-aware media validation and local file encoding helpers.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Stats } from 'node:fs';
import type { MediaKind, RecognitionProviderName } from '../types/index.js';

interface MediaFormat {
  extension: string;
  mimeType: string;
}

const IMAGE_FORMATS: MediaFormat[] = [
  { extension: '.jpg', mimeType: 'image/jpeg' },
  { extension: '.jpeg', mimeType: 'image/jpeg' },
  { extension: '.png', mimeType: 'image/png' },
  { extension: '.webp', mimeType: 'image/webp' }
];

const AUDIO_FORMATS: MediaFormat[] = [
  { extension: '.mp3', mimeType: 'audio/mp3' },
  { extension: '.wav', mimeType: 'audio/wav' },
  { extension: '.ogg', mimeType: 'audio/ogg' }
];

const OPENAI_COMPATIBLE_AUDIO_FORMATS: MediaFormat[] = [
  { extension: '.wav', mimeType: 'audio/wav' },
  { extension: '.mp3', mimeType: 'audio/mp3' }
];

const GEMINI_VIDEO_FORMATS: MediaFormat[] = [
  { extension: '.mp4', mimeType: 'video/mp4' }
];

const OPENAI_COMPATIBLE_VIDEO_FORMATS: MediaFormat[] = [
  { extension: '.mp4', mimeType: 'video/mp4' },
  { extension: '.mpeg', mimeType: 'video/mpeg' },
  { extension: '.mov', mimeType: 'video/mov' },
  { extension: '.avi', mimeType: 'video/x-msvideo' },
  { extension: '.webm', mimeType: 'video/webm' }
];

export interface MediaDetails {
  filepath: string;
  extension: string;
  mimeType: string;
  sizeBytes: number;
}

export interface MediaValidationOptions {
  allowedMediaRoots?: readonly string[];
}

interface MediaRootEnv {
  ALLOWED_MEDIA_ROOTS?: string;
  MEDIA_ROOTS?: string;
}

function formatsFor(provider: RecognitionProviderName, mediaKind: MediaKind): MediaFormat[] {
  if (mediaKind === 'image') {
    return IMAGE_FORMATS;
  }

  if (mediaKind === 'audio') {
    return provider === 'gemini' ? AUDIO_FORMATS : OPENAI_COMPATIBLE_AUDIO_FORMATS;
  }

  if (provider === 'gemini') {
    return GEMINI_VIDEO_FORMATS;
  }

  return OPENAI_COMPATIBLE_VIDEO_FORMATS;
}

export function supportedFormatMessage(providerLabel: string, provider: RecognitionProviderName, mediaKind: MediaKind): string {
  const formats = formatsFor(provider, mediaKind);
  if (formats.length === 0) {
    return `${providerLabel} does not currently support ${mediaKind} recognition in this server`;
  }

  return `${providerLabel} supported ${mediaKind} formats are: ${formats.map(format => format.extension).join(', ')}`;
}

export async function validateMediaFile(
  providerLabel: string,
  provider: RecognitionProviderName,
  mediaKind: MediaKind,
  filepath: string,
  options?: MediaValidationOptions
): Promise<MediaDetails> {
  const roots = options?.allowedMediaRoots === undefined
    ? await resolveAllowedMediaRoots()
    : await resolveAllowedMediaRootPaths(options.allowedMediaRoots);
  const confinementEnabled = roots.length > 0;
  const label = safeMediaLabel(filepath);

  const stats = confinementEnabled
    ? await validateConfinedFile(filepath, mediaKind, label, roots)
    : await validateUnconfinedFile(filepath, mediaKind, label);

  if (!stats.isFile()) {
    throw new Error(`${capitalizedMediaKind(mediaKind)} path is not a file: ${label}`);
  }

  const extension = path.extname(filepath).toLowerCase();
  const formats = formatsFor(provider, mediaKind);
  const format = formats.find(candidate => candidate.extension === extension);

  if (!format) {
    throw new Error(`Unsupported ${mediaKind} format for ${providerLabel}: ${extension || '(none)'}. ${supportedFormatMessage(providerLabel, provider, mediaKind)}`);
  }

  return {
    filepath,
    extension,
    mimeType: format.mimeType,
    sizeBytes: stats.size
  };
}

export function parseAllowedMediaRoots(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') {
    return [];
  }

  return raw
    .split(path.delimiter)
    .map(entry => entry.trim())
    .filter(entry => entry.length > 0);
}

export async function resolveAllowedMediaRoots(
  env: MediaRootEnv = process.env
): Promise<string[]> {
  const allowedMediaRoots = parseAllowedMediaRoots(env.ALLOWED_MEDIA_ROOTS);
  const mediaRoots = parseAllowedMediaRoots(env.MEDIA_ROOTS);

  if (allowedMediaRoots.length > 0 && mediaRoots.length > 0) {
    throw new Error('Ambiguous media root configuration: both ALLOWED_MEDIA_ROOTS and MEDIA_ROOTS are set. Use ALLOWED_MEDIA_ROOTS only.');
  }

  return resolveAllowedMediaRootPaths(allowedMediaRoots.length > 0 ? allowedMediaRoots : mediaRoots);
}

async function resolveAllowedMediaRootPaths(roots: readonly string[]): Promise<string[]> {
  const resolvedRoots: string[] = [];

  for (const root of roots) {
    let rootStats: Stats;
    try {
      rootStats = await fs.lstat(root);
    } catch {
      throw new Error(`Configured media root is not accessible: ${safeMediaLabel(root)}`);
    }

    if (!rootStats.isDirectory() && !rootStats.isSymbolicLink()) {
      throw new Error(`Configured media root is not a directory: ${safeMediaLabel(root)}`);
    }

    let realRoot: string;
    let realRootStats: Stats;
    try {
      realRoot = await fs.realpath(root);
      realRootStats = await fs.lstat(realRoot);
    } catch {
      throw new Error(`Configured media root is not accessible: ${safeMediaLabel(root)}`);
    }

    if (!realRootStats.isDirectory()) {
      throw new Error(`Configured media root is not a directory: ${safeMediaLabel(root)}`);
    }

    resolvedRoots.push(realRoot);
  }

  return resolvedRoots;
}

async function validateUnconfinedFile(filepath: string, mediaKind: MediaKind, label: string): Promise<Stats> {
  try {
    return await fs.stat(filepath);
  } catch {
    throw new Error(`${capitalizedMediaKind(mediaKind)} file not found: ${label}`);
  }
}

async function validateConfinedFile(
  filepath: string,
  mediaKind: MediaKind,
  label: string,
  roots: readonly string[]
): Promise<Stats> {
  try {
    await fs.lstat(filepath);
  } catch {
    throw new Error(`${capitalizedMediaKind(mediaKind)} file not found: ${label}`);
  }

  let realFilepath: string;
  try {
    realFilepath = await fs.realpath(filepath);
  } catch {
    throw new Error(`${capitalizedMediaKind(mediaKind)} file not found: ${label}`);
  }

  if (!roots.some(root => isPathInsideRoot(realFilepath, root))) {
    throw new Error(`${capitalizedMediaKind(mediaKind)} file is outside configured media roots: ${label}`);
  }

  try {
    return await fs.stat(realFilepath);
  } catch {
    throw new Error(`${capitalizedMediaKind(mediaKind)} file not found: ${label}`);
  }
}

function isPathInsideRoot(candidatePath: string, rootPath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function capitalizedMediaKind(mediaKind: MediaKind): string {
  return `${mediaKind[0].toUpperCase()}${mediaKind.slice(1)}`;
}

function safeMediaLabel(filepath: string): string {
  const labels = [path.basename(filepath), path.win32.basename(filepath), path.posix.basename(filepath)]
    .map(label => label.trim())
    .filter(label => label.length > 0 && label !== '.' && label !== path.sep);

  labels.sort((a, b) => a.length - b.length);
  return labels[0] ?? 'requested media file';
}

export async function createBase64DataUrl(media: MediaDetails, maxInlineMediaBytes: number): Promise<string> {
  if (media.sizeBytes > maxInlineMediaBytes) {
    throw new Error(`Inline media file is too large: ${media.sizeBytes} bytes. MAX_INLINE_MEDIA_BYTES is ${maxInlineMediaBytes}; reduce the file size or configure a larger limit if your provider supports it.`);
  }

  const fileBuffer = await fs.readFile(media.filepath);
  return `data:${media.mimeType};base64,${fileBuffer.toString('base64')}`;
}

export async function createRawBase64(media: MediaDetails, maxInlineMediaBytes: number): Promise<string> {
  if (media.sizeBytes > maxInlineMediaBytes) {
    throw new Error(`Inline media file is too large: ${media.sizeBytes} bytes. MAX_INLINE_MEDIA_BYTES is ${maxInlineMediaBytes}; reduce the file size or configure a larger limit if your provider supports it.`);
  }

  const fileBuffer = await fs.readFile(media.filepath);
  return fileBuffer.toString('base64');
}

export function audioFormatFromExtension(extension: string): string {
  return extension.replace(/^\./, '');
}