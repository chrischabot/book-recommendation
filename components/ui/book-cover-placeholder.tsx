"use client";

import { cn } from "@/lib/utils";

interface BookCoverPlaceholderProps {
  title: string;
  author?: string;
  className?: string;
}

/**
 * Generates a deterministic color based on the title
 */
function getTitleColor(title: string): string {
  const colors = [
    "from-slate-600 to-slate-800",
    "from-stone-600 to-stone-800",
    "from-zinc-600 to-zinc-800",
    "from-neutral-600 to-neutral-800",
    "from-red-800 to-red-950",
    "from-orange-800 to-orange-950",
    "from-amber-800 to-amber-950",
    "from-yellow-800 to-yellow-950",
    "from-lime-800 to-lime-950",
    "from-green-800 to-green-950",
    "from-emerald-800 to-emerald-950",
    "from-teal-800 to-teal-950",
    "from-cyan-800 to-cyan-950",
    "from-sky-800 to-sky-950",
    "from-blue-800 to-blue-950",
    "from-indigo-800 to-indigo-950",
    "from-violet-800 to-violet-950",
    "from-purple-800 to-purple-950",
    "from-fuchsia-800 to-fuchsia-950",
    "from-pink-800 to-pink-950",
    "from-rose-800 to-rose-950",
  ];

  // Simple hash based on title
  let hash = 0;
  for (let i = 0; i < title.length; i++) {
    hash = (hash << 5) - hash + title.charCodeAt(i);
    hash = hash & hash;
  }

  return colors[Math.abs(hash) % colors.length];
}

/**
 * A styled placeholder for books without cover images.
 * Shows the title and author on a colored gradient background.
 */
export function BookCoverPlaceholder({
  title,
  author,
  className,
}: BookCoverPlaceholderProps) {
  const gradientColor = getTitleColor(title);

  return (
    <div
      className={cn(
        "absolute inset-0 flex flex-col justify-between p-4",
        "bg-gradient-to-br",
        gradientColor,
        className
      )}
    >
      {/* Decorative book spine effect */}
      <div className="absolute left-0 inset-y-0 w-3 bg-black/20" />
      <div className="absolute left-3 inset-y-0 w-[1px] bg-white/10" />

      {/* Decorative top edge */}
      <div className="absolute top-0 inset-x-0 h-2 bg-gradient-to-b from-white/10 to-transparent" />

      {/* Content */}
      <div className="relative z-10 flex flex-col h-full justify-center px-3">
        {/* Title */}
        <h3 className="font-serif font-bold text-white text-center leading-tight line-clamp-4 drop-shadow-md text-sm sm:text-base">
          {title}
        </h3>

        {/* Author */}
        {author && (
          <p className="mt-2 text-white/80 text-center text-xs sm:text-sm line-clamp-2 font-medium drop-shadow">
            {author}
          </p>
        )}
      </div>

      {/* Bottom decorative line */}
      <div className="absolute bottom-4 left-1/2 -translate-x-1/2 w-12 h-[2px] bg-white/20 rounded-full" />
    </div>
  );
}
