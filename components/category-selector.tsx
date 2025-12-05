"use client";

import { useRouter } from "next/navigation";
import { cn, formatCategoryName } from "@/lib/utils";

interface CategorySelectorProps {
  categories: { slug: string }[];
  currentSlug: string;
}

export function CategorySelector({ categories, currentSlug }: CategorySelectorProps) {
  const router = useRouter();

  return (
    <select
      className={cn(
        "w-full rounded-lg border border-border bg-card px-4 py-2.5 text-sm",
        "focus:outline-none focus:ring-2 focus:ring-primary focus:border-primary"
      )}
      defaultValue={currentSlug}
      onChange={(e) => {
        router.push(`/category/${e.target.value}`);
      }}
    >
      {categories.map((cat) => (
        <option key={cat.slug} value={cat.slug}>
          {formatCategoryName(cat.slug)}
        </option>
      ))}
    </select>
  );
}
