"use client";

import ReactMarkdown from "react-markdown";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";

interface MarkdownDescriptionProps {
  children: string;
  className?: string;
  /** Maximum lines to show (uses line-clamp) */
  lineClamp?: 2 | 3 | 4 | 5 | 6;
  /** Prose size variant */
  size?: "sm" | "base";
}

const lineClampClasses = {
  2: "line-clamp-2",
  3: "line-clamp-3",
  4: "line-clamp-4",
  5: "line-clamp-5",
  6: "line-clamp-6",
} as const;

/**
 * Renders markdown-formatted book descriptions with consistent styling.
 * Handles bold, italic, lists, blockquotes, and links.
 */
export function MarkdownDescription({
  children,
  className,
  lineClamp,
  size = "base",
}: MarkdownDescriptionProps) {
  return (
    <div
      className={cn(
        "prose prose-stone dark:prose-invert max-w-none",
        // Size variants
        size === "sm" && "prose-sm",
        // Text color overrides
        "prose-p:text-foreground-muted prose-p:leading-relaxed prose-p:my-2",
        "prose-strong:text-foreground prose-strong:font-semibold",
        "prose-em:text-foreground-muted",
        // List styling
        "prose-ul:my-2 prose-ul:pl-4 prose-li:text-foreground-muted prose-li:my-0.5",
        "prose-ol:my-2 prose-ol:pl-4",
        // Blockquote styling
        "prose-blockquote:border-l-primary prose-blockquote:text-foreground-muted prose-blockquote:not-italic prose-blockquote:my-2",
        // Link styling
        "prose-a:text-primary prose-a:no-underline hover:prose-a:underline",
        // Line clamp support (explicit classes for Tailwind purging)
        lineClamp && lineClampClasses[lineClamp],
        className
      )}
    >
      <ReactMarkdown
        remarkPlugins={[
          remarkGfm, // GitHub Flavored Markdown (tables, strikethrough, etc.)
          remarkBreaks, // Converts single newlines to <br> tags
        ]}
        components={{
          // Override p to not add extra margins in clamped mode
          p: ({ children }) => (
            <p className={cn(lineClamp && "mb-0")}>{children}</p>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

/**
 * Inline markdown for short snippets (removes block-level elements)
 */
export function MarkdownInline({
  children,
  className,
}: {
  children: string;
  className?: string;
}) {
  return (
    <span className={cn("text-foreground-muted", className)}>
      <ReactMarkdown
        components={{
          p: ({ children }) => <>{children}</>,
          // Convert lists to inline comma-separated
          ul: ({ children }) => <>{children}</>,
          ol: ({ children }) => <>{children}</>,
          li: ({ children }) => <span>{children}, </span>,
          // Remove blockquotes
          blockquote: ({ children }) => <span>{children}</span>,
        }}
        allowedElements={["p", "strong", "em", "a", "ul", "ol", "li"]}
      >
        {children}
      </ReactMarkdown>
    </span>
  );
}
