"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import type { User } from "@supabase/supabase-js";
import { supabase } from "@/lib/client/supabase";

/** The signed-in editor, or a redirect to the sign-in page. Guests (anonymous users) are not editors. */
export function useEditorSession(): User | null {
  const router = useRouter();
  const [user, setUser] = useState<User | null>(null);
  useEffect(() => {
    const sb = supabase();
    const check = (u: User | null | undefined) => {
      if (!u || u.is_anonymous) router.replace("/");
      else setUser(u);
    };
    sb.auth.getSession().then(({ data }) => check(data.session?.user));
    const { data } = sb.auth.onAuthStateChange((_e, s) => check(s?.user));
    return () => data.subscription.unsubscribe();
  }, [router]);
  return user;
}
