"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { Loader2, Plus, Eye, EyeOff } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { browserCreateUser } from "@/lib/api";
import { createUserSchema, type CreateUserInput } from "@/lib/validation";

export function AddUserDialog() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [showPassword, setShowPassword] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);
  const [generalError, setGeneralError] = useState<string | null>(null);
  const form = useForm<CreateUserInput>({
    resolver: zodResolver(createUserSchema),
    defaultValues: { username: "", password: "", confirmPassword: "" },
  });

  function closeAndReset() {
    setOpen(false);
    form.reset();
    setGeneralError(null);
  }

  async function onSubmit(values: CreateUserInput) {
    setGeneralError(null);
    const result = await browserCreateUser({
      username: values.username,
      password: values.password,
    });
    if (result.ok) {
      toast.success("User created.");
      closeAndReset();
      router.refresh();
      return;
    }
    if (result.networkError || result.status >= 500) {
      setGeneralError(
        "The service is temporarily unavailable. Try again shortly.",
      );
      return;
    }
    const error = result.error;
    if (error?.fields) {
      for (const [field, message] of Object.entries(error.fields)) {
        if (
          field === "username" ||
          field === "password" ||
          field === "confirmPassword"
        ) {
          form.setError(field, { message });
        }
      }
      return;
    }
    setGeneralError(error?.message ?? "Check the submitted fields.");
  }

  const pending = form.formState.isSubmitting;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) closeAndReset();
        else setOpen(true);
      }}
    >
      <DialogTrigger asChild>
        <Button className="spring-interactive">
          <Plus aria-hidden /> Add user
        </Button>
      </DialogTrigger>
      <DialogContent className="spring-enter sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="text-base font-semibold tracking-tight">
            Add user
          </DialogTitle>
          <DialogDescription>
            Create an ordinary user account.
          </DialogDescription>
        </DialogHeader>
        <div className="mb-1 h-px bg-border" role="presentation" />
        <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4" noValidate>
          <div className="space-y-2">
            <Label htmlFor="create-username">Username</Label>
            <Input
              id="create-username"
              autoComplete="off"
              {...form.register("username")}
            />
            {form.formState.errors.username ? (
              <p className="text-sm text-destructive">
                {form.formState.errors.username.message}
              </p>
            ) : null}
          </div>
          <div className="space-y-2">
            <Label htmlFor="create-password">Password</Label>
            <div className="relative">
              <Input
                id="create-password"
                type={showPassword ? "text" : "password"}
                autoComplete="new-password"
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
          <div className="space-y-2">
            <Label htmlFor="create-confirm">Confirm password</Label>
            <Input
              id="create-confirm"
              type={showPassword ? "text" : "password"}
              autoComplete="new-password"
              {...form.register("confirmPassword")}
            />
            {form.formState.errors.confirmPassword ? (
              <p className="text-sm text-destructive">
                {form.formState.errors.confirmPassword.message}
              </p>
            ) : null}
          </div>
          {generalError ? (
            <Alert variant="destructive" aria-live="polite">
              <AlertDescription>{generalError}</AlertDescription>
            </Alert>
          ) : null}
          <DialogFooter className="gap-2 pt-2">
            <Button
              type="button"
              variant="outline"
              className="spring-interactive"
              onClick={closeAndReset}
            >
              Cancel
            </Button>
            <Button type="submit" className="spring-interactive" disabled={pending}>
              {pending ? (
                <>
                  <Loader2 className="size-4 animate-spin" aria-hidden />{" "}
                  Creating…
                </>
              ) : (
                "Create user"
              )}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
