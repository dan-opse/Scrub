import { UploadPartCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { asCaller, handle, HttpError, loadVersion } from "@/lib/server/auth";
import { BUCKET, s3 } from "@/lib/server/storage";

// Signs upload URLs for a batch of parts, valid for one hour each.
export const POST = handle(async (req) => {
  const { db } = await asCaller(req);
  const { versionId, partNumbers } = (await req.json()) as { versionId: string; partNumbers: number[] };
  const { version, access } = await loadVersion(db, versionId);
  if (access.role !== "editor" || !version.upload_id) throw new HttpError(403, "No active upload");
  if (!Array.isArray(partNumbers) || partNumbers.length > 50) throw new HttpError(400, "Bad part list");
  const urls = await Promise.all(
    partNumbers.map(async (n) => ({
      partNumber: n,
      url: await getSignedUrl(
        s3,
        new UploadPartCommand({ Bucket: BUCKET, Key: version.original_key, UploadId: version.upload_id, PartNumber: n }),
        { expiresIn: 3600 },
      ),
    })),
  );
  return { urls };
});
