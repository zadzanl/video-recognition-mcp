/**
 * Provider-aware media validation and local file encoding helpers.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
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
  filepath: string
): Promise<MediaDetails> {
  let stats;
  try {
    stats = await fs.stat(filepath);
  } catch {
    throw new Error(`${mediaKind[0].toUpperCase()}${mediaKind.slice(1)} file not found: ${filepath}`);
  }

  if (!stats.isFile()) {
    throw new Error(`${mediaKind[0].toUpperCase()}${mediaKind.slice(1)} path is not a file: ${filepath}`);
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