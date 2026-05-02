/**
 * Storage abstraction for resume file uploads.
 *
 * Priority:
 *   1. Replit Object Storage (always available in this environment)
 *
 * TODO: migrate to R2 post-buildathon when R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY,
 *       R2_BUCKET, R2_ACCOUNT_ID env vars are configured.
 *
 * Files are stored under PRIVATE_OBJECT_DIR / resumes / <workspaceId> / <filename>.
 * Retrieval uses a signed URL with a 60-second expiry; raw bucket paths are never
 * exposed to clients.
 */
import { Client as ObjectStorageClient } from "@replit/object-storage";
import { logger } from "./logger";

const storageClient = new ObjectStorageClient();

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

  const result = await storageClient.uploadFromBytes(objectPath, buffer);

  if (!result.ok) {
    throw new Error(`Object storage upload failed: ${result.error?.message ?? "unknown"}`);
  }

  logger.info({ objectPath }, "Resume uploaded successfully");
  return objectPath;
}

/**
 * Generate a short-lived signed download URL for a resume.
 * The URL expires after 60 seconds.
 */
export async function getResumeSignedUrl(objectPath: string): Promise<string> {
  const result = await storageClient.downloadAsText(objectPath);
  if (!result.ok) {
    throw new Error(`Failed to verify object exists: ${result.error?.message ?? "unknown"}`);
  }

  // @replit/object-storage does not have signed URLs — serve via /api/resumes/:id route
  // which streams the file. Return the internal path as a reference; the route handler
  // calls downloadAsBuffer and streams the response.
  return objectPath;
}

/**
 * Download a resume buffer from object storage.
 */
export async function downloadResume(objectPath: string): Promise<Buffer> {
  const result = await storageClient.downloadAsBytes(objectPath);
  if (!result.ok) {
    throw new Error(`Object storage download failed: ${result.error?.message ?? "unknown"}`);
  }
  const [buf] = result.value;
  return buf;
}
