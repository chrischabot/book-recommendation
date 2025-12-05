"use client";

import { Button } from "@/components/ui/button";

export function RetryButton({ className }: { className?: string }) {
  return (
    <Button className={className} onClick={() => window.location.reload()}>
      Try Again
    </Button>
  );
}
