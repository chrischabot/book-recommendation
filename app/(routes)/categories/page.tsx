import type { Metadata } from "next";
import Link from "next/link";
import { Library, ArrowRight, BookOpen, Sparkles } from "lucide-react";
import { getCategoryMetadata } from "@/lib/config/categories";
import { cn, formatCategoryName } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Browse Categories",
  description: "Explore our curated book collections across genres and topics.",
};

// Category icons and colors
const categoryStyles: Record<
  string,
  { icon: string; gradient: string; description: string }
> = {
  "science-fiction": {
    icon: "🚀",
    gradient: "from-violet-500 to-purple-600",
    description: "Explore futures, space, and technology",
  },
  "hard-sci-fi": {
    icon: "🔬",
    gradient: "from-cyan-500 to-blue-600",
    description: "Science fiction with technical rigor",
  },
  "space-opera": {
    icon: "🌌",
    gradient: "from-indigo-500 to-purple-600",
    description: "Epic space adventures and galactic empires",
  },
  "cyberpunk": {
    icon: "🤖",
    gradient: "from-pink-500 to-rose-600",
    description: "High tech meets low life",
  },
  "high-fantasy": {
    icon: "🐉",
    gradient: "from-emerald-500 to-teal-600",
    description: "Epic fantasy worlds and quests",
  },
  "urban-fantasy": {
    icon: "🏙️",
    gradient: "from-amber-500 to-orange-600",
    description: "Magic in modern cities",
  },
  "literary-fiction": {
    icon: "✨",
    gradient: "from-rose-400 to-pink-500",
    description: "Literary and contemporary works",
  },
  "mystery": {
    icon: "🔍",
    gradient: "from-amber-500 to-orange-600",
    description: "Detective stories and whodunits",
  },
  "thriller": {
    icon: "🎭",
    gradient: "from-red-500 to-rose-600",
    description: "Suspense and edge-of-seat tension",
  },
  "horror": {
    icon: "👻",
    gradient: "from-gray-700 to-gray-900",
    description: "Supernatural and psychological horror",
  },
  "romance": {
    icon: "💕",
    gradient: "from-pink-400 to-rose-500",
    description: "Love stories and relationships",
  },
  "historical-fiction": {
    icon: "🏰",
    gradient: "from-amber-600 to-yellow-700",
    description: "Stories set in the past",
  },
  "biography": {
    icon: "📖",
    gradient: "from-blue-500 to-indigo-600",
    description: "Real lives and memoirs",
  },
  "biography-20th": {
    icon: "📰",
    gradient: "from-slate-500 to-gray-600",
    description: "20th century figures",
  },
  "business": {
    icon: "💼",
    gradient: "from-green-500 to-emerald-600",
    description: "Business and entrepreneurship",
  },
  "business-narrative": {
    icon: "📊",
    gradient: "from-teal-500 to-cyan-600",
    description: "Narrative business books",
  },
  "self-help": {
    icon: "🌱",
    gradient: "from-lime-500 to-green-600",
    description: "Personal development",
  },
  "philosophy": {
    icon: "🤔",
    gradient: "from-purple-500 to-indigo-600",
    description: "Philosophy and ethics",
  },
  "history": {
    icon: "🏛️",
    gradient: "from-stone-500 to-stone-700",
    description: "World history and analysis",
  },
  "science": {
    icon: "🔭",
    gradient: "from-blue-400 to-cyan-500",
    description: "Popular science topics",
  },
  "technology": {
    icon: "💻",
    gradient: "from-gray-600 to-slate-700",
    description: "Tech and computing",
  },
};

// Group categories by type
const categoryGroups = [
  {
    title: "Fiction",
    icon: BookOpen,
    categories: [
      "science-fiction",
      "hard-sci-fi",
      "space-opera",
      "cyberpunk",
      "high-fantasy",
      "urban-fantasy",
      "literary-fiction",
      "mystery",
      "thriller",
      "horror",
      "romance",
      "historical-fiction",
    ],
  },
  {
    title: "Non-Fiction",
    icon: Sparkles,
    categories: [
      "biography",
      "biography-20th",
      "history",
      "science",
      "philosophy",
      "business",
      "business-narrative",
      "self-help",
      "technology",
    ],
  },
];

export default function CategoriesPage() {
  const allCategories = getCategoryMetadata();
  const categorySet = new Set(allCategories.map((c) => c.slug));

  return (
    <div className="min-h-screen">
      {/* Hero Header */}
      <section className="relative overflow-hidden bg-background-warm border-b border-border">
        <div className="absolute inset-0 -z-10">
          <div className="absolute top-0 left-1/4 w-72 h-72 bg-primary/5 rounded-full blur-3xl" />
          <div className="absolute bottom-0 right-1/4 w-72 h-72 bg-secondary/5 rounded-full blur-3xl" />
        </div>

        <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
          <div className="text-center animate-fade-up">
            <div className="inline-flex items-center gap-2 text-primary mb-3">
              <Library className="h-5 w-5" />
              <span className="text-sm font-medium uppercase tracking-wider">
                Explore
              </span>
            </div>
            <h1 className="font-display text-4xl md:text-5xl font-bold text-foreground">
              Browse Categories
            </h1>
            <p className="mt-4 text-lg text-foreground-muted max-w-2xl mx-auto">
              Dive into our curated collections across genres and discover your
              next great read.
            </p>
          </div>
        </div>
      </section>

      {/* Category Groups */}
      <section className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8">
        <div className="space-y-16">
          {categoryGroups.map((group, groupIndex) => {
            const GroupIcon = group.icon;
            const availableCategories = group.categories.filter((slug) =>
              categorySet.has(slug)
            );

            if (availableCategories.length === 0) return null;

            return (
              <div
                key={group.title}
                className="animate-fade-up"
                style={{ animationDelay: `${groupIndex * 100}ms` }}
              >
                <div className="flex items-center gap-3 mb-6">
                  <div className="p-2 rounded-lg bg-primary/10">
                    <GroupIcon className="h-5 w-5 text-primary" />
                  </div>
                  <h2 className="font-display text-2xl font-bold text-foreground">
                    {group.title}
                  </h2>
                </div>

                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
                  {availableCategories.map((slug, index) => {
                    const style = categoryStyles[slug] ?? {
                      icon: "📚",
                      gradient: "from-gray-500 to-gray-600",
                      description: formatCategoryName(slug),
                    };

                    return (
                      <Link
                        key={slug}
                        href={`/category/${slug}`}
                        className={cn(
                          "group relative overflow-hidden rounded-xl p-5",
                          "bg-card border border-border/50 shadow-card",
                          "transition-all duration-300",
                          "hover:shadow-book hover:-translate-y-1 hover:border-primary/20"
                        )}
                        style={{ animationDelay: `${(groupIndex * 100) + (index * 50)}ms` }}
                      >
                        {/* Gradient background on hover */}
                        <div
                          className={cn(
                            "absolute inset-0 opacity-0 group-hover:opacity-5 transition-opacity duration-300",
                            "bg-gradient-to-br",
                            style.gradient
                          )}
                        />

                        <div className="relative">
                          <div className="flex items-start justify-between">
                            <span className="text-3xl mb-3 block">
                              {style.icon}
                            </span>
                            <ArrowRight className="h-4 w-4 text-foreground-muted opacity-0 group-hover:opacity-100 transition-all duration-200 group-hover:translate-x-1" />
                          </div>
                          <h3 className="font-display text-lg font-semibold text-foreground group-hover:text-primary transition-colors">
                            {formatCategoryName(slug)}
                          </h3>
                          <p className="mt-1 text-sm text-foreground-muted line-clamp-2">
                            {style.description}
                          </p>
                        </div>
                      </Link>
                    );
                  })}
                </div>
              </div>
            );
          })}
        </div>
      </section>
    </div>
  );
}
