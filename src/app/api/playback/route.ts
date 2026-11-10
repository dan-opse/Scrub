import { GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { asCaller, handle, HttpError, loadVersion } from "@/lib/server/auth";
import { BUCKET, PLAYBACK_TTL_SECONDS, s3 } from "@/lib/server/storage";

// A short-lived signed URL for watching (or, if allowed, downloading) a version's original or review copy.
export const POST = handle(async (req) => {
  const { db } = await asCaller(req);
  const { versionId, download, source = "original" } = (await req.json()) as {
    versionId: string;
    download?: boolean;
    source?: "original" | "review";
  };
  const { version, access } = await loadVersion(db, versionId);
  if (version.status !== "ready" || !version.original_key) throw new HttpError(409, "This version isn't ready yet");
  if (download && !access.allow_download) throw new HttpError(403, "Downloads are turned off for this link");
  const review = source === "review";
  if (review && (version.review_status !== "ready" || !version.review_key)) throw new HttpError(409, "No review copy yet");
  const safeName = String(version.original_filename).replace(/[^\w.\- ]+/g, "_");
  const url = await getSignedUrl(
    s3,
    new GetObjectCommand({
      Bucket: BUCKET,
      Key: review ? version.review_key : version.original_key,
      ResponseContentType: "video/mp4",
      ...(download ? { ResponseContentDisposition: `attachment; filename="${review ? "review-" : ""}${safeName}"` } : {}),
    }),
    { expiresIn: PLAYBACK_TTL_SECONDS },
  );
  return { url, expiresAt: Date.now() + PLAYBACK_TTL_SECONDS * 1000 };
});
