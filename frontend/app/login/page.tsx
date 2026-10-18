import type { Metadata } from "next";
import { LoginForm } from "@/components/login-form";

export const metadata: Metadata = {
  title: "Sign in — Archive",
};

export default function LoginPage() {
  return (
    <main className="relative flex min-h-svh flex-col items-center justify-center bg-[#050506] px-4 py-12">
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 bg-[linear-gradient(to_right,rgba(255,255,255,0.018)_1px,transparent_1px),linear-gradient(to_bottom,rgba(255,255,255,0.018)_1px,transparent_1px)] bg-[size:32px_32px]"
      />
      <div className="relative z-10 w-full max-w-[380px]">
        <LoginForm />
      </div>
    </main>
  );
}
