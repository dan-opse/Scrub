"use client";
import { useCallback, useEffect, useState } from "react";
import { supabase, errorMessage } from "@/lib/client/supabase";
import type { Approval } from "@/lib/types";

/** Approval decisions for one version, newest first, kept live. */
export function useApprovals(versionId: string) {
  const [approvals, setApprovals] = useState<Approval[]>([]);

  const refetch = useCallback(async () => {
    const { data } = await supabase().from("approvals").select("*").eq("version_id", versionId).order("created_at", { ascending: false });
    if (data) setApprovals(data as Approval[]);
  }, [versionId]);

  useEffect(() => {
    const sb = supabase();
    const channel = sb
      .channel(`approvals:${versionId}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "approvals", filter: `version_id=eq.${versionId}` }, () => refetch())
      .subscribe((status) => status === "SUBSCRIBED" && refetch());
    return () => {
      sb.removeChannel(channel);
    };
  }, [versionId, refetch]);

  const decide = useCallback(
    async (decision: Approval["decision"], note: string) => {
      const { error } = await supabase().from("approvals").insert({ version_id: versionId, decision, note: note.trim() });
      if (error) throw new Error(errorMessage(error));
      await refetch();
    },
    [versionId, refetch],
  );

  return { approvals, latest: approvals[0] ?? null, decide };
}
