import Link from "next/link";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { ArrowUpRight } from "lucide-react";
import { Icon3D, Magnetic } from "@/components/kinetics-ui";
import { RetryErrorBoundary } from "@/components/retry-error";
import { Card, CardContent } from "@/components/ui/card";
import { serverGetMe } from "@/lib/api";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const cookieHeader = (await cookies()).toString();
  const me = await serverGetMe(cookieHeader);
  if (!me.ok && me.status === 401) {
    redirect("/login");
  }
  if (!me.ok) {
    return <RetryErrorBoundary />;
  }

  const user = me.data.user;
  const canReadUsers = user.permissions.includes("users:read");
  const canReadRoles = user.permissions.includes("roles:read");
  const canReadAudit = user.permissions.includes("audit:read");

  return (
    <div className="flex flex-1 flex-col spring-enter">
      <Card className="max-w-md border-[rgba(255,255,255,0.05)] bg-[#0f1011]">
        <CardContent className="flex flex-col gap-3 p-0">
          <p className="text-[12px] font-[510] uppercase tracking-wider text-[#62666d]">
            Quick navigation
          </p>
          <div className="kinetics-stagger flex flex-col gap-2.5">
            <Magnetic strength={0.18}>
              <Link
                href="/archives"
                className="group flex items-center justify-between gap-3 rounded-[8px] border border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.02)] px-3.5 py-2.5 transition-[transform,background-color,border-color] duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:scale-[1.015] hover:border-[rgba(255,255,255,0.14)] hover:bg-[rgba(255,255,255,0.05)] active:scale-[0.98]"
              >
                <div className="flex items-center gap-3">
                  <Icon3D name="tools" size="sm" />
                  <div className="flex flex-col">
                    <span className="text-[14px] font-[510] text-[#f7f8f8]">
                      Archives vault
                    </span>
                    <span className="text-[12px] text-[#8a8f98]">
                      Upload, unlock &amp; index .zip, .7z, and .rar without
                      extraction
                    </span>
                  </div>
                </div>
                <ArrowUpRight
                  aria-hidden
                  className="size-4 text-[#62666d] transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-[#ffffff]"
                />
              </Link>
            </Magnetic>
            <Magnetic strength={0.18}>
              <Link
                href="/cards"
                className="group flex items-center justify-between gap-3 rounded-[8px] border border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.02)] px-3.5 py-2.5 transition-[transform,background-color,border-color] duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:scale-[1.015] hover:border-[rgba(255,255,255,0.14)] hover:bg-[rgba(255,255,255,0.05)] active:scale-[0.98]"
              >
                <div className="flex items-center gap-3">
                  <Icon3D name="key" size="sm" />
                  <div className="flex flex-col">
                    <span className="text-[14px] font-[510] text-[#f7f8f8]">
                      Cards ledger
                    </span>
                    <span className="text-[12px] text-[#8a8f98]">
                      Credit cards, expiration, CVV &amp; holder names
                    </span>
                  </div>
                </div>
                <ArrowUpRight
                  aria-hidden
                  className="size-4 text-[#62666d] transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-[#ffffff]"
                />
              </Link>
            </Magnetic>
            {canReadUsers ? (
              <Magnetic strength={0.18}>
                <Link
                  href="/users"
                  className="group flex items-center justify-between gap-3 rounded-[8px] border border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.02)] px-3.5 py-2.5 transition-[transform,background-color,border-color] duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:scale-[1.015] hover:border-[rgba(255,255,255,0.14)] hover:bg-[rgba(255,255,255,0.05)] active:scale-[0.98]"
                >
                  <div className="flex items-center gap-3">
                    <Icon3D name="target" size="sm" />
                    <div className="flex flex-col">
                      <span className="text-[14px] font-[510] text-[#f7f8f8]">
                        Users directory
                      </span>
                      <span className="text-[12px] text-[#8a8f98]">
                        Accounts, suspension, sessions &amp; recovery
                      </span>
                    </div>
                  </div>
                  <ArrowUpRight
                    aria-hidden
                    className="size-4 text-[#62666d] transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-[#ffffff]"
                  />
                </Link>
              </Magnetic>
            ) : null}
            {canReadRoles ? (
              <Magnetic strength={0.18}>
                <Link
                  href="/roles"
                  className="group flex items-center justify-between gap-3 rounded-[8px] border border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.02)] px-3.5 py-2.5 transition-[transform,background-color,border-color] duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:scale-[1.015] hover:border-[rgba(255,255,255,0.14)] hover:bg-[rgba(255,255,255,0.05)] active:scale-[0.98]"
                >
                  <div className="flex items-center gap-3">
                    <Icon3D name="shield" size="sm" />
                    <div className="flex flex-col">
                      <span className="text-[14px] font-[510] text-[#f7f8f8]">
                        Roles &amp; permissions
                      </span>
                      <span className="text-[12px] text-[#8a8f98]">
                        RBAC policy definitions &amp; grants
                      </span>
                    </div>
                  </div>
                  <ArrowUpRight
                    aria-hidden
                    className="size-4 text-[#62666d] transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-[#ffffff]"
                  />
                </Link>
              </Magnetic>
            ) : null}
            {canReadAudit ? (
              <Magnetic strength={0.18}>
                <Link
                  href="/audit"
                  className="group flex items-center justify-between gap-3 rounded-[8px] border border-[rgba(255,255,255,0.06)] bg-[rgba(255,255,255,0.02)] px-3.5 py-2.5 transition-[transform,background-color,border-color] duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] hover:scale-[1.015] hover:border-[rgba(255,255,255,0.14)] hover:bg-[rgba(255,255,255,0.05)] active:scale-[0.98]"
                >
                  <div className="flex items-center gap-3">
                    <Icon3D name="notebook" size="sm" />
                    <div className="flex flex-col">
                      <span className="text-[14px] font-[510] text-[#f7f8f8]">
                        Audit log
                      </span>
                      <span className="text-[12px] text-[#8a8f98]">
                        Append-only security event ledger
                      </span>
                    </div>
                  </div>
                  <ArrowUpRight
                    aria-hidden
                    className="size-4 text-[#62666d] transition-transform duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)] group-hover:translate-x-0.5 group-hover:-translate-y-0.5 group-hover:text-[#ffffff]"
                  />
                </Link>
              </Magnetic>
            ) : null}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
