import { Suspense } from "react";
import { GuestPage } from "@/components/GuestPage";

export default function Page() {
  return (
    <Suspense>
      <GuestPage />
    </Suspense>
  );
}
