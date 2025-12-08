"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { AlertTriangle, RefreshCw, Home, ChevronDown } from "lucide-react";

export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  const [showDetails, setShowDetails] = useState(false);
  const isDev = process.env.NODE_ENV === "development";

  useEffect(() => {
    // Log the error to an error reporting service
    console.error("Application error:", error);
  }, [error]);

  return (
    <div className="min-h-[60vh] flex items-center justify-center px-4">
      <div className="max-w-2xl w-full text-center space-y-6">
        <div className="flex justify-center">
          <div className="rounded-full bg-destructive/10 p-4">
            <AlertTriangle className="h-12 w-12 text-destructive" />
          </div>
        </div>

        <div className="space-y-2">
          <h1 className="font-display text-2xl font-bold text-foreground">
            Something went wrong
          </h1>
          <p className="text-foreground-muted">
            We encountered an unexpected error. Our apologies for the inconvenience.
          </p>
          {error.digest && (
            <p className="text-xs text-foreground-subtle font-mono mt-2">
              Error ID: {error.digest}
            </p>
          )}
        </div>

        {/* Enhanced error details in development mode */}
        {isDev && (error.message || error.stack) && (
          <div className="text-left">
            <button
              onClick={() => setShowDetails(!showDetails)}
              className="w-full flex items-center justify-between px-4 py-3 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg text-left"
            >
              <span className="font-medium text-red-800 dark:text-red-300 text-sm">
                Error Details (Development Only)
              </span>
              <ChevronDown
                className={`h-4 w-4 text-red-600 dark:text-red-400 transition-transform ${
                  showDetails ? "rotate-180" : ""
                }`}
              />
            </button>
            {showDetails && (
              <div className="mt-2 p-4 bg-red-50 dark:bg-red-950/30 border border-red-200 dark:border-red-800 rounded-lg space-y-3">
                {error.message && (
                  <div>
                    <h4 className="text-xs font-semibold text-red-700 dark:text-red-400 uppercase tracking-wide">
                      Message
                    </h4>
                    <p className="mt-1 text-sm text-red-600 dark:text-red-300 font-mono">
                      {error.message}
                    </p>
                  </div>
                )}
                {error.stack && (
                  <div>
                    <h4 className="text-xs font-semibold text-red-700 dark:text-red-400 uppercase tracking-wide">
                      Stack Trace
                    </h4>
                    <pre className="mt-1 text-xs text-red-600 dark:text-red-300 font-mono overflow-x-auto whitespace-pre-wrap break-all max-h-64 overflow-y-auto">
                      {error.stack}
                    </pre>
                  </div>
                )}
              </div>
            )}
          </div>
        )}

        <div className="flex flex-col sm:flex-row items-center justify-center gap-3">
          <button
            onClick={reset}
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg bg-primary text-primary-foreground font-medium hover:bg-primary-hover transition-colors"
          >
            <RefreshCw className="h-4 w-4" />
            Try again
          </button>
          <Link
            href="/"
            className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-border text-foreground font-medium hover:bg-muted transition-colors"
          >
            <Home className="h-4 w-4" />
            Go home
          </Link>
        </div>

        <p className="text-sm text-foreground-subtle">
          If this problem persists, please{" "}
          <a
            href="https://github.com/anthropics/claude-code/issues"
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline"
          >
            report an issue
          </a>
          .
        </p>
      </div>
    </div>
  );
}
