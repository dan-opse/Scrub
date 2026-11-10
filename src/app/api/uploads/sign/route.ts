import { UploadPartCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { asCaller, handle, HttpError, loadVersion } from "@/lib/server/auth";
import { BUCKET, cols, s3, type UploadKind } from "@/lib/server/storage";

// Signs upload URLs for a batch of parts, valid for one hour each.
export const POST = handle(async (req) => {
  const { db } = await asCaller(req);
  const { versionId, kind = "original", partNumbers } = (await req.json()) as { versionId: string; kind?: UploadKind; partNumbers: number[] };
  const { version, access } = await loadVersion(db, versionId);
  const c = cols(kind);
  const uploadId = version[c.uploadId] as string | null;
  const key = version[c.key] as string | null;
  if (access.role !== "editor" || !uploadId || !key) throw new HttpError(403, "No active upload");
  if (!Array.isArray(partNumbers) || partNumbers.length > 50) throw new HttpError(400, "Bad part list");
  const urls = await Promise.all(
    partNumbers.map(async (n) => ({
      partNumber: n,
      url: await getSignedUrl(s3, new UploadPartCommand({ Bucket: BUCKET, Key: key, UploadId: uploadId, PartNumber: n }), { expiresIn: 3600 }),
    })),
  );
  return { urls };
});
