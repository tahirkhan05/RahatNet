'use client';

/**
 * PhotoUploader — optional photo attachment for need reports.
 *
 * On mobile: opens the rear camera directly via `capture="environment"`.
 * On desktop: opens the file picker (JPEG/PNG/WebP).
 *
 * Client-side compression before upload:
 *  - Max dimension 800 px (preserves aspect ratio).
 *  - JPEG quality 0.8.
 *  - A 6 MB phone photo typically shrinks to ~100–150 KB.
 *  - This is critical on 2G — 150 KB uploads in ~4 s vs 6 MB in ~2.5 minutes.
 *
 * Upload flow:
 *  1. User picks a file (camera or gallery).
 *  2. Client-side compression runs synchronously (canvas API).
 *  3. Compressed blob is uploaded to Firebase Storage via `uploadNeedPhoto`.
 *  4. Download URL is returned to parent via `onUploaded(url)`.
 *  5. Progress is shown during the upload (0–100%).
 */

import * as React from 'react';
import { Camera, ImagePlus, X, Loader2, AlertCircle } from 'lucide-react';
import { t } from '@/lib/i18n/t';

const MAX_FILE_SIZE_MB = 10;
const MAX_DIMENSION = 800;
const JPEG_QUALITY = 0.8;

interface PhotoUploaderProps {
  userId: string;
  /** Called with the Firebase Storage download URL after upload, or null on removal. */
  onUploaded: (url: string | null) => void;
  disabled?: boolean;
}

// ---------------------------------------------------------------------------
// Compression helper (no external deps — just Canvas API)
// ---------------------------------------------------------------------------

async function compressAndConvert(file: File): Promise<Blob> {
  const objectUrl = URL.createObjectURL(file);
  try {
    return await new Promise<Blob>((resolve, reject) => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not read image'));
      img.onload = () => {
        let { width, height } = img;
        if (width > MAX_DIMENSION || height > MAX_DIMENSION) {
          if (width >= height) {
            height = Math.round((height * MAX_DIMENSION) / width);
            width = MAX_DIMENSION;
          } else {
            width = Math.round((width * MAX_DIMENSION) / height);
            height = MAX_DIMENSION;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        if (ctx === null) { resolve(file); return; }
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(
          (blob) => blob !== null ? resolve(blob) : resolve(file),
          'image/jpeg',
          JPEG_QUALITY,
        );
      };
      img.src = objectUrl;
    });
  } finally {
    URL.revokeObjectURL(objectUrl);
  }
}

// ---------------------------------------------------------------------------
// Component
// ---------------------------------------------------------------------------

export function PhotoUploader({ userId, onUploaded, disabled = false }: PhotoUploaderProps) {
  const [preview, setPreview] = React.useState<string | null>(null);
  const [uploadProgress, setUploadProgress] = React.useState<number | null>(null);
  const [error, setError] = React.useState<string | null>(null);
  const fileInputRef = React.useRef<HTMLInputElement>(null);
  const previewUrlRef = React.useRef<string | null>(null);

  // Revoke object URL on unmount or when preview changes.
  React.useEffect(() => {
    return () => {
      if (previewUrlRef.current != null) URL.revokeObjectURL(previewUrlRef.current);
    };
  }, []);

  const handleFile = async (file: File) => {
    setError(null);

    // File-size guard.
    if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
      setError(`File is too large (max ${MAX_FILE_SIZE_MB} MB).`);
      return;
    }

    // Build a local preview immediately so the user sees the photo.
    const localUrl = URL.createObjectURL(file);
    if (previewUrlRef.current != null) URL.revokeObjectURL(previewUrlRef.current);
    previewUrlRef.current = localUrl;
    setPreview(localUrl);
    setUploadProgress(0);

    try {
      const compressed = await compressAndConvert(file);
      const { uploadNeedPhoto } = await import('@/lib/firebase/storage');
      const downloadUrl = await uploadNeedPhoto(userId, new File([compressed], file.name, { type: 'image/jpeg' }), {
        onProgress: setUploadProgress,
      });
      setUploadProgress(null);
      onUploaded(downloadUrl);
    } catch (err) {
      setUploadProgress(null);
      const msg = err instanceof Error ? err.message : 'Upload failed. Please try again.';
      setError(msg);
      setPreview(null);
      onUploaded(null);
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file != null) void handleFile(file);
    // Reset input so the same file can be re-selected after removal.
    e.target.value = '';
  };

  const handleRemove = () => {
    if (previewUrlRef.current != null) {
      URL.revokeObjectURL(previewUrlRef.current);
      previewUrlRef.current = null;
    }
    setPreview(null);
    setUploadProgress(null);
    setError(null);
    onUploaded(null);
  };

  const isUploading = uploadProgress !== null;

  // ---- With preview ----
  if (preview !== null) {
    return (
      <div className="space-y-2">
        <div className="relative overflow-hidden rounded-xl border border-border">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src={preview}
            alt="Attached photo preview"
            className="h-40 w-full object-cover"
          />

          {/* Upload progress overlay */}
          {isUploading && (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-background/80 backdrop-blur-sm">
              <Loader2 className="h-6 w-6 animate-spin text-primary" aria-hidden="true" />
              <div className="h-1.5 w-32 overflow-hidden rounded-full bg-secondary">
                <div
                  className="h-full rounded-full bg-primary transition-all"
                  style={{ width: `${uploadProgress}%` }}
                  role="progressbar"
                  aria-valuenow={uploadProgress}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-label={t('report.step2.photo.uploading')}
                />
              </div>
              <p className="text-xs text-muted-foreground">{uploadProgress}%</p>
            </div>
          )}

          {/* Remove button */}
          {!isUploading && (
            <button
              type="button"
              onClick={handleRemove}
              disabled={disabled}
              aria-label={t('report.step2.photo.remove')}
              className="absolute right-2 top-2 flex h-8 w-8 items-center justify-center rounded-full bg-background/90 text-foreground shadow-sm transition-colors hover:bg-destructive hover:text-destructive-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            >
              <X className="h-4 w-4" aria-hidden="true" />
            </button>
          )}
        </div>

        {error !== null && (
          <div role="alert" className="flex items-center gap-1.5 text-sm text-destructive">
            <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
            {error}
          </div>
        )}
      </div>
    );
  }

  // ---- No photo yet ----
  return (
    <div className="space-y-2">
      {/* Hidden file input — two: one for camera, one for gallery */}
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp"
        capture="environment"
        className="sr-only"
        aria-label="Take a photo"
        onChange={handleInputChange}
        disabled={disabled}
      />

      <div className="flex gap-2">
        {/* Camera capture (mobile primary) */}
        <label
          className={[
            'flex min-h-[48px] flex-1 cursor-pointer items-center justify-center gap-2 rounded-lg border border-border bg-background px-4 py-3 text-sm font-medium text-foreground',
            'transition-colors hover:bg-accent focus-within:ring-2 focus-within:ring-ring',
            disabled ? 'cursor-not-allowed opacity-60' : '',
          ].join(' ')}
        >
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            capture="environment"
            className="sr-only"
            onChange={handleInputChange}
            disabled={disabled}
            aria-label="Take a photo with camera"
          />
          <Camera className="h-4 w-4" aria-hidden="true" />
          Take photo
        </label>

        {/* Gallery fallback */}
        <label
          className={[
            'flex min-h-[48px] items-center justify-center gap-2 rounded-lg border border-border bg-background px-3 py-3 text-sm text-muted-foreground',
            'transition-colors hover:bg-accent focus-within:ring-2 focus-within:ring-ring',
            disabled ? 'cursor-not-allowed opacity-60' : 'cursor-pointer',
          ].join(' ')}
        >
          <input
            type="file"
            accept="image/jpeg,image/png,image/webp"
            className="sr-only"
            onChange={handleInputChange}
            disabled={disabled}
            aria-label="Choose from gallery"
          />
          <ImagePlus className="h-4 w-4" aria-hidden="true" />
          Gallery
        </label>
      </div>

      {error !== null && (
        <div role="alert" className="flex items-center gap-1.5 text-sm text-destructive">
          <AlertCircle className="h-4 w-4 shrink-0" aria-hidden="true" />
          {error}
        </div>
      )}
    </div>
  );
}
