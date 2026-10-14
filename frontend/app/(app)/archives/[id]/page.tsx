import { cookies } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { ArchiveExplorer } from "@/components/archive-explorer";
import { RetryErrorBoundary } from "@/components/retry-error";
import { serverGetArchiveDetail, serverGetMe } from "@/lib/api";

export const dynamic = "force-dynamic";

type ArchiveExplorerPageProps = {
  params: Promise<{ id: string }>;
  searchParams?: Promise<{ path?: string }>;
};

export default async function ArchiveExplorerPage({
  params,
  searchParams,
}: ArchiveExplorerPageProps) {
  const { id } = await params;
  const sp = searchParams ? await searchParams : {};
  const initialFilePath = typeof sp.path === "string" ? sp.path : undefined;
  const cookieHeader = (await cookies()).toString();
  const me = await serverGetMe(cookieHeader);
  if (!me.ok && me.status === 401) {
    redirect("/login");
  }
  if (!me.ok) {
    return <RetryErrorBoundary />;
  }

  const detail = await serverGetArchiveDetail(cookieHeader, id);
  if (!detail.ok) {
    if (detail.status === 401) {
      redirect("/login");
    }
    if (detail.status === 404) {
      notFound();
    }
    return <RetryErrorBoundary />;
  }

  return (
    <ArchiveExplorer
      initialDetail={detail.data}
      initialFilePath={initialFilePath}
    />
  );
}
