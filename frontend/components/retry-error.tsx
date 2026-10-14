"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";

/**
 * Rendered when the backend is unreachable or returns 5xx — never masquerades
 * as an authentication failure.
 */
export function RetryErrorBoundary() {
  const router = useRouter();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    if (attempt > 0) {
      router.refresh();
    }
  }, [attempt, router]);

  return (
    <main className="flex min-h-svh items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-4 text-center">
        <Alert variant="destructive" aria-live="polite">
          <AlertTitle>Something went wrong</AlertTitle>
          <AlertDescription>
            The service is temporarily unavailable. Try again.
          </AlertDescription>
        </Alert>
        <Button onClick={() => setAttempt((value) => value + 1)}>
          Try again
        </Button>
      </div>
    </main>
  );
}
