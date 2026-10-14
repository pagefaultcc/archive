import type { Metadata } from "next";
import { LoginForm } from "@/components/login-form";

export const metadata: Metadata = {
  title: "Sign in — Archive",
};

export default function LoginPage() {
  return (
    <main className="flex min-h-svh items-center justify-center bg-[radial-gradient(circle,rgba(0,0,0,0.035)_1px,transparent_1px)] [background-size:20px_20px] p-4">
      <div className="spring-enter w-full max-w-sm">
        <LoginForm />
      </div>
    </main>
  );
}
