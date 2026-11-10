import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { asCaller, handle, HttpError, loadVersion } from "@/lib/server/auth";
import { BUCKET, PLAYBACK_TTL_SECONDS, s3 } from "@/lib/server/storage";

// A short-lived signed URL for watching (or, if allowed, downloading) a version.
export const POST = handle(async (req) => {
  const { db } = await asCaller(req);
  const { versionId, download } = (await req.json()) as { versionId: string; download?: boolean };
  const { version, access } = await loadVersion(db, versionId);
  if (version.status !== "ready" || !version.original_key) throw new HttpError(409, "This version isn't ready yet");
  if (download && !access.allow_download) throw new HttpError(403, "Downloads are turned off for this link");
  const safeName = String(version.original_filename).replace(/[^\w.\- ]+/g, "_");
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: version.original_key,
      ResponseContentType: "video/mp4",
      ...(download ? { ResponseContentDisposition: `attachment; filename="${safeName}"` } : {}),
    }),
    { expiresIn: PLAYBACK_TTL_SECONDS },
  );
  return { url, expiresAt: Date.now() + PLAYBACK_TTL_SECONDS * 1000 };
});
