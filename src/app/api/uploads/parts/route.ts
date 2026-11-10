import { ListPartsCommand } from "@aws-sdk/client-s3";
import { asCaller, handle, HttpError, loadVersion } from "@/lib/server/auth";
import { BUCKET, cols, s3, type UploadKind } from "@/lib/server/storage";

// Lists parts already stored, so an interrupted upload can resume.
export const POST = handle(async (req) => {
  const { db } = await asCaller(req);
  const { versionId, kind = "original" } = (await req.json()) as { versionId: string; kind?: UploadKind };
  const { version, access } = await loadVersion(db, versionId);
  const c = cols(kind);
  const uploadId = version[c.uploadId] as string | null;
  const key = version[c.key] as string | null;
  if (access.role !== "editor" || !uploadId || !key) throw new HttpError(403, "No active upload");
  const parts: { partNumber: number; etag: string; size: number }[] = [];
  let marker: string | undefined;
  do {
    const res = await s3.send(new ListPartsCommand({ Bucket: BUCKET, Key: key, UploadId: uploadId, PartNumberMarker: marker }));
    for (const p of res.Parts ?? []) parts.push({ partNumber: p.PartNumber!, etag: p.ETag!, size: p.Size ?? 0 });
    marker = res.IsTruncated ? res.NextPartNumberMarker : undefined;
  } while (marker);
  return { parts };
});
