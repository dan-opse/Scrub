import { Suspense } from "react";
import { AssetPage } from "@/components/AssetPage";

export default function Page() {
  return (
    <Suspense>
      <AssetPage />
    </Suspense>
  );
}
