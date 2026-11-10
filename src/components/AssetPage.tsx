"use client";
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";
import { supabase } from "@/lib/client/supabase";
import { useEditorSession } from "./useEditorSession";
import { Review } from "./review/Review";
import type { Access } from "@/lib/types";

export function AssetPage() {
  const { id } = useParams<{ id: string }>();
  const user = useEditorSession();
  const [access, setAccess] = useState<Access | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!user) return;
    supabase()
      .rpc("my_asset_access", { p_asset: id })
      .then(({ data, error }) => {
        if (error || !data?.[0]) setError("This video doesn't exist or isn't yours.");
        else setAccess(data[0] as Access);
      });
  }, [user, id]);

  if (error) return <p className="p-8 text-center text-cut">{error}</p>;
  if (!user || !access) return <p className="p-8 text-center text-ink-3">Loading…</p>;
  return <Review assetId={id} me={{ id: user.id, name: access.display_name, role: access.role }} access={access} />;
}
