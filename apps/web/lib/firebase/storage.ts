'use client';

/**
 * Firebase Cloud Storage client library.
 *
 * Handles all file uploads and downloads for RahatNet:
 *
 *   need-photos/{userId}/{timestamp}-{filename}   — photos attached to needs
 *   field-reports/{disasterId}/{timestamp}-{filename} — NGO field reports (PDF/image)
 *   profile-photos/{userId}/{timestamp}-{filename} — volunteer profile pictures
 *
 * Design decisions:
 *
 * 1. Validation before upload
 *    File size (10 MB hard limit) and MIME type are checked client-side before
 *    any bytes are sent to Storage, giving instant feedback without burning
 *    bandwidth on 2G networks.
 *
 * 2. Image compression
 *    Need photos are compressed to ≤ 800 px and JPEG quality 0.8 before upload.
 *    This is critical for 2G/3G: a 6 MB DSLR photo becomes ~120 KB.
 *    Object URLs are revoked after use to prevent memory leaks.
 *
 * 3. Retry on upload
 *    `uploadBytesResumable` handles its own resumable upload protocol — if the
 *    connection drops mid-upload, the SDK resumes from the last byte sent.
 *    We additionally retry the *initial* task creation up to MAX_UPLOAD_RETRIES
 *    times for transient auth/quota errors that prevent even starting an upload.
 *
 * 4. Error normalisation
 *    All StorageError codes are mapped to user-facing AppError messages.
 *
 * 5. Logging
 *    Every operation logs operation start, progress milestones, and result.
 */

import {
  getStorage,
  ref,
  uploadBytesResumable,
  getDownloadURL as firebaseGetDownloadURL,
  deleteObject,
  type FirebaseStorage,
  type UploadTaskSnapshot,
  type StorageError,
} from 'firebase/storage';
import { firebaseApp } from './client';
import { AppError } from '@/lib/utils/errors';
import { createLogger } from './logger';
import type { LogContext } from './logger';

// ---------------------------------------------------------------------------
// Storage singleton
// ---------------------------------------------------------------------------

export const storage: FirebaseStorage = getStorage(firebaseApp);

const logger = createLogger('storage');

// ---------------------------------------------------------------------------
// Limits & allowed types
// ---------------------------------------------------------------------------

/** Maximum file size accepted for any upload (10 MB). */
const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024;

/** MIME types accepted for need photos. */
const ALLOWED_PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic']);

/** MIME types accepted for field reports (coordinators/NGO). */
const ALLOWED_REPORT_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
]);

const MAX_UPLOAD_RETRIES = 3;

// ---------------------------------------------------------------------------
// Error normalisation
// ---------------------------------------------------------------------------

const STORAGE_ERROR_MESSAGES: Readonly<Record<string, string>> = {
  'storage/unauthorized': 'You do not have permission to upload files.',
  'storage/canceled': 'Upload was cancelled.',
  'storage/unknown': 'An unknown upload error occurred. Please try again.',
  'storage/object-not-found': 'The file does not exist.',
  'storage/bucket-not-found': 'Storage not configured correctly. Please contact support.',
  'storage/project-not-found': 'Storage not configured correctly. Please contact support.',
  'storage/quota-exceeded': 'Storage quota exceeded. Please contact support.',
  'storage/unauthenticated': 'You must be signed in to upload files.',
  'storage/invalid-checksum':
    'File was corrupted during upload. Please try again.',
  'storage/server-file-wrong-size':
    'File size mismatch. Please try again.',
  'storage/retry-limit-exceeded':
    'Upload failed after multiple attempts. Please check your connection.',
};

function normaliseStorageError(err: unknown, operation: string): AppError {
  if (err instanceof AppError) return err;
  const se = err as Partial<StorageError>;
  const code = se.code ?? 'storage/unknown';
  const userMessage =
    STORAGE_ERROR_MESSAGES[code] ??
    'Upload failed. Please check your connection and try again.';

  logger.error(operation, 'Storage error', {
    name: se.name ?? 'StorageError',
    message: se.message ?? String(err),
    code,
  });

  return new AppError('UPSTREAM_ERROR', userMessage, 500);
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate file size and MIME type before upload.
 * Throws `AppError` with a user-facing message so the form can display it.
 */
function validateFile(file: File, allowedTypes: Set<string>, context: string): void {
  if (file.size > MAX_FILE_SIZE_BYTES) {
    throw new AppError(
      'VALIDATION_ERROR',
      `File is too large (${(file.size / 1024 / 1024).toFixed(1)} MB). Maximum allowed size is 10 MB.`,
      400,
    );
  }
  if (!allowedTypes.has(file.type)) {
    throw new AppError(
      'VALIDATION_ERROR',
      `File type "${file.type}" is not allowed for ${context}. ` +
        `Accepted types: ${[...allowedTypes].join(', ')}.`,
      400,
    );
  }
}

// ---------------------------------------------------------------------------
// Image compression
// ---------------------------------------------------------------------------

/**
 * Compress an image file to a maximum dimension while preserving aspect ratio.
 *
 * Implementation uses the Canvas API — only available in browser contexts.
 * The object URL is always revoked after use to prevent memory leaks.
 *
 * @param file          - original image File
 * @param maxDimension  - maximum width or height in pixels
 * @param quality       - JPEG quality [0, 1]
 * @returns Compressed Blob (JPEG)
 */
async function compressImage(file: File, maxDimension: number, quality: number): Promise<Blob> {
  const objectUrl = URL.createObjectURL(file);

  try {
    return await new Promise<Blob>((resolve, reject) => {
      const img = new Image();

      img.onerror = () => {
        reject(new AppError('VALIDATION_ERROR', 'Could not read image. The file may be corrupted.', 400));
      };

      img.onload = () => {
        let { width, height } = img;

        // Scale down proportionally if either dimension exceeds the limit.
        if (width > maxDimension || height > maxDimension) {
          if (width >= height) {
            height = Math.round((height * maxDimension) / width);
            width = maxDimension;
          } else {
            width = Math.round((width * maxDimension) / height);
            height = maxDimension;
          }
        }

        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;

        const ctx = canvas.getContext('2d');
        if (ctx === null) {
          resolve(file); // Canvas not available — upload original.
          return;
        }

        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => {
            if (blob !== null) {
              resolve(blob);
            } else {
              // toBlob returned null — fall back to the original file.
              resolve(file);
            }
          },
          'image/jpeg',
          quality,
        );
      };

      img.src = objectUrl;
    });
  } finally {
    // Always revoke — whether compression succeeded, failed, or threw.
    URL.revokeObjectURL(objectUrl);
  }
}

// ---------------------------------------------------------------------------
// Upload helpers
// ---------------------------------------------------------------------------

export interface UploadOptions {
  /** Called with progress percentage [0–100] as bytes are sent. */
  onProgress?: (percent: number) => void;
  /** Optional logging context. */
  ctx?: LogContext;
}

/**
 * Core upload implementation using `uploadBytesResumable`.
 *
 * `uploadBytesResumable` handles automatic resumption if the connection
 * drops mid-upload.  The returned Promise resolves with the public
 * download URL when the upload completes.
 *
 * We retry the initial task creation (not the byte transfer, which is
 * handled by the SDK) on transient errors up to MAX_UPLOAD_RETRIES times.
 */
async function uploadBlob(
  storagePath: string,
  blob: Blob,
  contentType: string,
  opts: UploadOptions,
): Promise<string> {
  const { onProgress, ctx } = opts;
  const storageRef = ref(storage, storagePath);

  let lastErr: unknown;

  for (let attempt = 1; attempt <= MAX_UPLOAD_RETRIES; attempt++) {
    try {
      const downloadUrl = await new Promise<string>((resolve, reject) => {
        const task = uploadBytesResumable(storageRef, blob, { contentType });

        task.on(
          'state_changed',
          (snapshot: UploadTaskSnapshot) => {
            const percent = Math.round(
              (snapshot.bytesTransferred / snapshot.totalBytes) * 100,
            );
            onProgress?.(percent);

            // Log 25%, 50%, 75%, 100% milestones in dev to monitor slow uploads.
            if ([25, 50, 75, 100].includes(percent)) {
              logger.debug(
                'uploadBlob',
                `${percent}% uploaded`,
                { path: storagePath, attempt },
                ctx,
              );
            }
          },
          (err) => reject(err),
          async () => {
            try {
              resolve(await firebaseGetDownloadURL(task.snapshot.ref));
            } catch (urlErr) {
              reject(urlErr);
            }
          },
        );
      });

      return downloadUrl;
    } catch (err) {
      lastErr = err;

      const se = err as Partial<StorageError>;
      const isRetryable =
        se.code === 'storage/retry-limit-exceeded' ||
        se.code === 'storage/unknown' ||
        // Network error before task could start
        (err instanceof Error && err.message.includes('network'));

      if (!isRetryable || attempt === MAX_UPLOAD_RETRIES) break;

      const delayMs = 1000 * attempt;
      logger.warn(
        'uploadBlob',
        `attempt ${attempt} failed — retrying in ${delayMs}ms`,
        normaliseStorageError(err, 'uploadBlob'),
        { path: storagePath },
        ctx,
      );
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }

  throw normaliseStorageError(lastErr, 'uploadBlob');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Upload a photo attached to a citizen need report.
 *
 * The image is compressed to ≤ 800 px / 0.8 JPEG quality before upload,
 * which typically reduces a 6 MB phone photo to ~100–150 KB.
 *
 * Storage path: `need-photos/{userId}/{timestamp}-{sanitisedFilename}`
 *
 * @param userId   - Firebase Auth UID of the uploading citizen
 * @param file     - raw file from the photo picker or camera capture
 * @param opts     - optional progress callback and logging context
 * @returns Firebase Storage download URL
 * @throws {AppError} on validation failure or upload error
 */
export async function uploadNeedPhoto(
  userId: string,
  file: File,
  opts: UploadOptions = {},
): Promise<string> {
  const { ctx } = opts;
  logger.info('uploadNeedPhoto', 'starting', { size: file.size, type: file.type }, ctx);

  validateFile(file, ALLOWED_PHOTO_TYPES, 'need photos');

  const compressed = await compressImage(file, 800, 0.8);
  logger.debug(
    'uploadNeedPhoto',
    `compressed ${file.size} → ${compressed.size} bytes`,
    undefined,
    ctx,
  );

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `need-photos/${userId}/${Date.now()}-${safeName}`;

  const url = await uploadBlob(path, compressed, 'image/jpeg', opts);
  logger.info('uploadNeedPhoto', 'complete', { path }, ctx);
  return url;
}

/**
 * Upload an NGO / NDRF field report document (PDF or image).
 *
 * Storage path: `field-reports/{disasterId}/{timestamp}-{sanitisedFilename}`
 *
 * @param file        - PDF or image file from the coordinator's device
 * @param disasterId  - disaster event ID for path scoping
 * @param opts        - optional progress callback and logging context
 * @returns Firebase Storage download URL
 * @throws {AppError} on validation failure or upload error
 */
export async function uploadFieldReport(
  file: File,
  disasterId: string,
  opts: UploadOptions = {},
): Promise<string> {
  const { ctx } = opts;
  logger.info('uploadFieldReport', 'starting', { size: file.size, type: file.type }, ctx);

  validateFile(file, ALLOWED_REPORT_TYPES, 'field reports');

  const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_');
  const path = `field-reports/${disasterId}/${Date.now()}-${safeName}`;

  const url = await uploadBlob(path, file, file.type, opts);
  logger.info('uploadFieldReport', 'complete', { path }, ctx);
  return url;
}

/**
 * Upload a volunteer profile photo.
 *
 * Compressed to ≤ 400 px (profile thumbnails don't need full resolution).
 * Storage path: `profile-photos/{userId}/{timestamp}-profile`
 *
 * @param userId  - Firebase Auth UID of the volunteer
 * @param file    - image file from the avatar picker
 * @param opts    - optional progress callback and logging context
 * @returns Firebase Storage download URL
 * @throws {AppError}
 */
export async function uploadProfilePhoto(
  userId: string,
  file: File,
  opts: UploadOptions = {},
): Promise<string> {
  const { ctx } = opts;
  logger.info('uploadProfilePhoto', 'starting', { size: file.size }, ctx);

  validateFile(file, ALLOWED_PHOTO_TYPES, 'profile photos');

  const compressed = await compressImage(file, 400, 0.85);
  const path = `profile-photos/${userId}/${Date.now()}-profile`;

  const url = await uploadBlob(path, compressed, 'image/jpeg', opts);
  logger.info('uploadProfilePhoto', 'complete', { path }, ctx);
  return url;
}

/**
 * Delete a file from Firebase Storage by its storage path (not download URL).
 *
 * @param storagePath  - e.g. 'need-photos/uid/1234-photo.jpg'
 * @param ctx          - optional logging context
 * @throws {AppError}  if the file cannot be found or the user lacks permission
 */
export async function deleteFile(storagePath: string, ctx?: LogContext): Promise<void> {
  logger.info('deleteFile', 'deleting', { path: storagePath }, ctx);
  try {
    await deleteObject(ref(storage, storagePath));
    logger.info('deleteFile', 'deleted', { path: storagePath }, ctx);
  } catch (err) {
    throw normaliseStorageError(err, 'deleteFile');
  }
}

/**
 * Get the public download URL for a file by its storage path.
 *
 * @param storagePath  - e.g. 'need-photos/uid/1234-photo.jpg'
 * @param ctx          - optional logging context
 * @returns HTTPS download URL valid for the lifetime of the file
 * @throws {AppError}
 */
export async function getDownloadURL(storagePath: string, ctx?: LogContext): Promise<string> {
  logger.debug('getDownloadURL', 'fetching URL', { path: storagePath }, ctx);
  try {
    const url = await firebaseGetDownloadURL(ref(storage, storagePath));
    logger.debug('getDownloadURL', 'URL fetched', { path: storagePath }, ctx);
    return url;
  } catch (err) {
    throw normaliseStorageError(err, 'getDownloadURL');
  }
}
