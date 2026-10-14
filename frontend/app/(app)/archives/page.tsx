import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ArchivesVault } from "@/components/archives-vault";
import { RetryErrorBoundary } from "@/components/retry-error";
import { serverGetMe, serverListArchives } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function ArchivesPage() {
  const cookieHeader = (await cookies()).toString();
  const me = await serverGetMe(cookieHeader);
  if (!me.ok && me.status === 401) {
    redirect("/login");
  }
  if (!me.ok) {
    return <RetryErrorBoundary />;
  }

  const archivesResult = await serverListArchives(cookieHeader);
  if (!archivesResult.ok && archivesResult.status === 401) {
    redirect("/login");
  }
  if (!archivesResult.ok) {
    return <RetryErrorBoundary />;
  }

  return (
    <ArchivesVault initialArchives={archivesResult.data.archives} />
  );
}
