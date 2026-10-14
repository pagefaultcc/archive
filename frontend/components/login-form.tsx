"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, Eye, EyeOff } from "lucide-react";
import { BorderBeam } from "border-beam";
import { Card } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Icon3D, Magnetic } from "@/components/kinetics-ui";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  browserLogin,
  type ApiRequestError,
  type SessionUser,
} from "@/lib/api";
import { loginSchema, type LoginInput } from "@/lib/validation";
import { usePrefersReducedMotion } from "@/hooks/use-prefers-reduced-motion";

function destination(user: SessionUser): string {
  return user.permissions.includes("users:read") ? "/users" : "/";
}

export function LoginForm() {
  const router = useRouter();
  const reducedMotion = usePrefersReducedMotion();
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
      router.replace(destination(result.data.user));
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
    <BorderBeam
      size="line"
      colorVariant="mono"
      theme="auto"
      strength={0.5}
      active={!reducedMotion}
      className="w-full max-w-sm rounded-xl"
    >
      <Card className="border-border/70 bg-card p-8 shadow-sm">
        <div className="mb-8 flex flex-col items-center gap-3 text-center">
          <Icon3D name="key" size="lg" />
          <div>
            <h1 className="text-lg font-semibold tracking-tight">Archive</h1>
            <p className="mt-1 text-sm text-muted-foreground">
              Welcome back! Please sign in to continue.
            </p>
          </div>
        </div>
        <form
          onSubmit={form.handleSubmit(onSubmit)}
          className="space-y-4"
          noValidate
        >
          <div className="space-y-2">
            <Label htmlFor="username">Username</Label>
            <Input
              id="username"
              autoComplete="username"
              autoFocus
              {...form.register("username")}
            />
            {form.formState.errors.username ? (
              <p className="text-sm text-destructive">
                {form.formState.errors.username.message}
              </p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="password">Password</Label>
            <div className="relative">
              <Input
                id="password"
                type={showPassword ? "text" : "password"}
                autoComplete="current-password"
                className="pr-10"
                {...form.register("password")}
              />
              <button
                type="button"
                onClick={() => setShowPassword((value) => !value)}
                aria-label={showPassword ? "Hide password" : "Show password"}
                className="spring-interactive absolute inset-y-0 right-0 flex items-center px-3 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
              >
                {showPassword ? (
                  <EyeOff className="size-4" aria-hidden />
                ) : (
                  <Eye className="size-4" aria-hidden />
                )}
              </button>
            </div>
            {form.formState.errors.password ? (
              <p className="text-sm text-destructive">
                {form.formState.errors.password.message}
              </p>
            ) : null}
          </div>
          {generalError ? (
            <Alert variant="destructive" aria-live="polite">
              <AlertDescription>{generalError}</AlertDescription>
            </Alert>
          ) : null}
          <Magnetic strength={0.22}>
            <Button
              type="submit"
              className="spring-interactive w-full"
              disabled={form.formState.isSubmitting}
            >
              {form.formState.isSubmitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden /> Signing
                  in…
                </>
              ) : (
                "Sign in"
              )}
            </Button>
          </Magnetic>
        </form>
        <p className="mt-6 text-center text-xs text-muted-foreground">
          Protected by Argon2id PHC &amp; server-side session RBAC.
        </p>
      </Card>
    </BorderBeam>
  );
}
