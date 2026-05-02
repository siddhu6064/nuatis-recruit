/**
 * Storage abstraction for resume file uploads.
 *
 * Uses @google-cloud/storage directly with Replit sidecar authentication.
 * Files are stored under PRIVATE_OBJECT_DIR/resumes/<workspaceId>/<filename>.
 */
import { Storage } from "@google-cloud/storage";
import { logger } from "./logger";

const storage = new Storage();

function getBucket() {
  const bucketId = process.env.DEFAULT_OBJECT_STORAGE_BUCKET_ID;
  if (!bucketId) {
    throw new Error("DEFAULT_OBJECT_STORAGE_BUCKET_ID env var is not set");
  }
  return storage.bucket(bucketId);
}

function buildObjectPath(workspaceId: string, filename: string): string {
  const dir = process.env.PRIVATE_OBJECT_DIR ?? "private";
  return `${dir}/resumes/${workspaceId}/${filename}`;
}

/**
 * Upload a resume buffer to object storage.
 * Returns the internal object path (not a public URL).
 */
export async function uploadResume(
  workspaceId: string,
  filename: string,
  buffer: Buffer,
  mimeType: string,
): Promise<string> {
  const objectPath = buildObjectPath(workspaceId, filename);
  logger.info({ objectPath, mimeType, bytes: buffer.byteLength }, "Uploading resume");

  const bucket = getBucket();
  const file = bucket.file(objectPath);
  await file.save(buffer, { contentType: mimeType });

  logger.info({ objectPath }, "Resume uploaded successfully");
  return objectPath;
}

/**
 * Download a resume buffer from object storage.
 */
export async function downloadResume(objectPath: string): Promise<Buffer> {
  const bucket = getBucket();
  const file = bucket.file(objectPath);
  const [contents] = await file.download();
  return contents;
}

/**
 * Returns the internal object path — there are no public presigned URLs.
 * Retrieval is done via /api/resumes/:id which streams from storage.
 */
export async function getResumeSignedUrl(objectPath: string): Promise<string> {
  return objectPath;
}
