import { Suspense } from "react";
import type { Metadata } from "next";
import Link from "next/link";
import { ArrowLeft, Dna, BookOpen, User, Tag } from "lucide-react";
import { Button } from "@/components/ui/button";
import { TasteProfileFull } from "@/components/taste-profile-full";

export const metadata: Metadata = {
  title: "Your Reading DNA",
  description: "Books that define your taste profile and shape your recommendations",
};

function ProfileSkeleton() {
  return (
    <div className="space-y-6">
      <div className="animate-pulse bg-card/30 rounded-xl p-6 h-32" />
      <div className="animate-pulse bg-card/30 rounded-xl p-6 h-64" />
      <div className="animate-pulse bg-card/30 rounded-xl p-6 h-96" />
    </div>
  );
}

export default function ProfilePage() {
  return (
    <div className="min-h-screen">
      {/* Header */}
      <div className="border-b border-border bg-background-warm">
        <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
          <Button
            asChild
            variant="ghost"
            size="sm"
            className="mb-4 -ml-2"
          >
            <Link href="/recommendations">
              <ArrowLeft className="h-4 w-4 mr-1" />
              Back to Recommendations
            </Link>
          </Button>

          <div className="flex items-start gap-4">
            <div className="p-3 rounded-xl bg-primary/10 shrink-0">
              <Dna className="h-8 w-8 text-primary" />
            </div>
            <div>
              <h1 className="font-display text-3xl md:text-4xl font-bold text-foreground">
                Your Reading DNA
              </h1>
              <p className="mt-2 text-foreground-muted max-w-xl">
                These books define your taste profile. They shape which books we
                recommend and help us understand what you love to read.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Content */}
      <div className="mx-auto max-w-4xl px-4 py-8 sm:px-6 lg:px-8">
        <Suspense fallback={<ProfileSkeleton />}>
          <TasteProfileFull userId="me" />
        </Suspense>
      </div>
    </div>
  );
}
