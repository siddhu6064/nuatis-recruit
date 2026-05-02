/**
 * Storage abstraction for resume file uploads.
 *
 * Uses @replit/object-storage with explicit bucketId from DEFAULT_OBJECT_STORAGE_BUCKET_ID.
 * Files are stored under PRIVATE_OBJECT_DIR/resumes/<workspaceId>/<filename>.
 */
import { Client as ObjectStorageClient } from "@replit/object-storage";
import { logger } from "./logger";

let _storageClient: ObjectStorageClient | null = null;

function getStorageClient(): ObjectStorageClient {
  if (!_storageClient) {
    const bucketId = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
    _storageClient = bucketId
      ? new ObjectStorageClient({ bucketId })
      : new ObjectStorageClient();
  }
  return _storageClient;
}

function buildObjectPath(workspaceId: string, filename: string): string {
  const dir = process.env.PRIVATE_OBJECT_DIR ?? "private";
  return `${dir}/resumes/${workspaceId}/${filename}`;
}

/**
 * Upload a resume buffer to object storage.
 * Returns the internal object path (not a public URL).
 * In development, falls back to a stub path if object storage is unavailable.
 */
export async function uploadResume(
  workspaceId: string,
  filename: string,
  buffer: Buffer,
  mimeType: string,
): Promise<string> {
  const objectPath = buildObjectPath(workspaceId, filename);
  logger.info({ objectPath, mimeType, bytes: buffer.byteLength }, "Uploading resume");

  try {
    const result = await getStorageClient().uploadFromBytes(objectPath, buffer);
    if (!result.ok) {
      throw new Error(`Object storage upload failed: ${result.error?.message ?? "unknown"}`);
    }
    logger.info({ objectPath }, "Resume uploaded successfully");
  } catch (err) {
    if (process.env.NODE_ENV === "production") {
      throw err;
    }
    logger.warn(
      { err, objectPath },
      "Object storage upload failed in dev — using stub path for AI pipeline",
    );
  }

  return objectPath;
}

/**
 * Download a resume buffer from object storage.
 */
export async function downloadResume(objectPath: string): Promise<Buffer> {
  const result = await getStorageClient().downloadAsBytes(objectPath);
  if (!result.ok) {
    throw new Error(`Object storage download failed: ${result.error?.message ?? "unknown"}`);
  }
  const [buf] = result.value;
  return buf;
}

/**
 * Returns the internal object path. Retrieval is done via /api/resumes/:id
 * which streams from object storage.
 */
export async function getResumeSignedUrl(objectPath: string): Promise<string> {
  return objectPath;
}
