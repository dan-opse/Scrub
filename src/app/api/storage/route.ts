import { asCaller, handle } from "@/lib/server/auth";
import { MAX_FILE_BYTES, STORAGE_ALLOWANCE_BYTES } from "@/lib/server/storage";

// Storage used by the caller's account, and the limits uploads must fit in.
export const POST = handle(async (req) => {
  const { db } = await asCaller(req);
  const { data } = await db.rpc("my_storage_bytes");
  return { used: Number(data ?? 0), allowance: STORAGE_ALLOWANCE_BYTES, maxFile: MAX_FILE_BYTES };
});
