"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, Eye, EyeOff, Terminal } from "lucide-react";
import { MotionSurface } from "@/components/motion-surface";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  browserLogin,
  type ApiRequestError,
} from "@/lib/api";
import { loginSchema, type LoginInput } from "@/lib/validation";

export function LoginForm() {
  const router = useRouter();
  const [showPassword, setShowPassword] = useState(false);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { username: "", password: "" },
  });

  async function onSubmit(values: LoginInput) {
    setGeneralError(null);
    const result = await browserLogin(values);
    if (result.ok) {
      const target = result.data.user.permissions.includes("users:read")
        ? "/users"
        : "/";
      router.replace(target);
      return;
    }
    if (result.networkError || result.status >= 500) {
      setGeneralError(
        "The service is temporarily unavailable. Try again shortly.",
      );
      return;
    }
    const error = result.error as ApiRequestError | null;
    if (error?.fields) {
      for (const [field, message] of Object.entries(error.fields)) {
        if (field === "username" || field === "password") {
          form.setError(field, { message });
        }
      }
      return;
    }
    setGeneralError(
      error?.message ?? "Check the submitted fields.",
    );
  }

  return (
    <MotionSurface radius={10} className="w-full">
      <div className="rounded-xl border border-white/[0.07] bg-[#0b0c0e] p-7 shadow-[0_24px_48px_rgba(0,0,0,0.6)]">
        <div className="mb-6 flex flex-col gap-3">
          <div className="flex items-center justify-between">
            <div className="flex size-9 items-center justify-center rounded-lg border border-white/[0.08] bg-[#121418] text-[#f3f4f6]">
              <Terminal className="size-4" />
            </div>
            <span className="obsidian-pill font-mono text-[10px] uppercase tracking-wider">
              Vault Auth
            </span>
          </div>
          <div className="mt-1">
            <h1 className="text-lg font-semibold tracking-tight text-[#f3f4f6]">
              Sign in to Archive
            </h1>
            <p className="mt-1 text-xs text-[#8b909a]">
              Enter your operator credentials to access the workspace.
            </p>
          </div>
        </div>

        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className="space-y-4"
          noValidate
        >
          <div className="space-y-1.5">
            <Label htmlFor="username" className="text-xs font-medium text-[#c8ccd4]">
              Username
            </Label>
            <Input
              id="username"
              autoComplete="username"
              autoFocus
              className="obsidian-input h-9"
              {...form.register("username")}
            />
            {form.formState.errors.username ? (
              <p className="text-xs text-[#f43f5e]">
                {form.formState.errors.username.message}
              </p>
            ) : null}
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="password" className="text-xs font-medium text-[#c8ccd4]">
              Password
            </Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                className="obsidian-input h-9 pr-9"
                {...form.register("password")}
              />
              <button
                type="button"
                onClick={() => setShowPassword((value) => !value)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                className="absolute inset-y-0 right-0 flex items-center px-2.5 text-[#8b909a] hover:text-[#f3f4f6] focus-visible:outline-none"
              >
                {showPassword ? (
                  <EyeOff className="size-3.5" aria-hidden />
                ) : (
                  <Eye className="size-3.5" aria-hidden />
                )}
              </button>
            </div>
            {form.formState.errors.password ? (
              <p className="text-xs text-[#f43f5e]">
                {form.formState.errors.password.message}
              </p>
            ) : null}
          </div>

          {generalError ? (
            <Alert variant="destructive" aria-live="polite" className="py-2.5 text-xs">
              <AlertDescription>{generalError}</AlertDescription>
            </Alert>
          ) : null}

          <Button
            type="submit"
            className="h-9 w-full rounded-lg bg-[#f3f4f6] text-xs font-medium text-[#050506] hover:bg-white"
            disabled={form.formState.isSubmitting}
          >
            {form.formState.isSubmitting ? (
              <>
                <Loader2 className="size-3.5 animate-spin" aria-hidden /> Signing in…
              </>
            ) : (
              "Sign in"
            )}
          </Button>
        </form>

        <div className="mt-6 border-t border-white/[0.05] pt-4 text-center">
          <p className="font-mono text-[11px] text-[#5c606a]">
            Argon2id PHC · Session RBAC
          </p>
        </div>
      </div>
    </MotionSurface>
  );
}
