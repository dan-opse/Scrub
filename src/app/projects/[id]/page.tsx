import { Suspense } from "react";
import { ProjectPage } from "@/components/ProjectPage";

export default function Page() {
  return (
    <Suspense>
      <ProjectPage />
    </Suspense>
  );
}
