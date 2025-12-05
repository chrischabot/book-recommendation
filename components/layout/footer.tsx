import Link from "next/link";
import { BookOpen, Github, Heart } from "lucide-react";
import { cn } from "@/lib/utils";

const footerLinks = {
  discover: [
    { href: "/recommendations", label: "For You" },
    { href: "/category/science-fiction", label: "Science Fiction" },
    { href: "/category/high-fantasy", label: "Fantasy" },
    { href: "/category/mystery", label: "Mystery" },
    { href: "/category/biography", label: "Biography" },
  ],
  genres: [
    { href: "/category/thriller", label: "Thriller" },
    { href: "/category/romance", label: "Romance" },
    { href: "/category/history", label: "History" },
    { href: "/category/science", label: "Science" },
    { href: "/category/philosophy", label: "Philosophy" },
  ],
  resources: [
    { href: "#", label: "How It Works" },
    { href: "#", label: "Import Library" },
    { href: "#", label: "Privacy" },
  ],
};

export function Footer() {
  return (
    <footer className="relative mt-auto border-t border-border bg-background-warm">
      {/* Decorative top border */}
      <div className="absolute top-0 inset-x-0 h-px bg-gradient-to-r from-transparent via-primary/30 to-transparent" />

      <div className="mx-auto max-w-7xl px-4 py-12 sm:px-6 lg:px-8 lg:py-16">
        <div className="grid gap-8 lg:grid-cols-4">
          {/* Brand section */}
          <div className="lg:col-span-1">
            <Link href="/" className="inline-flex items-center gap-2.5 group">
              <div className="flex items-center justify-center w-10 h-10 rounded-xl bg-primary/10 group-hover:bg-primary/20 transition-colors">
                <BookOpen className="h-5 w-5 text-primary" />
              </div>
              <span className="font-display text-xl font-bold text-foreground">
                Librarian
              </span>
            </Link>
            <p className="mt-4 text-sm text-foreground-muted leading-relaxed max-w-xs">
              Your personal book recommendation engine. Discover your next
              favorite read based on your unique taste.
            </p>
            <div className="mt-6 flex items-center gap-4">
              <a
                href="https://github.com"
                target="_blank"
                rel="noopener noreferrer"
                className="text-foreground-muted hover:text-foreground transition-colors"
              >
                <Github className="h-5 w-5" />
              </a>
            </div>
          </div>

          {/* Link columns */}
          <div className="grid gap-8 sm:grid-cols-3 lg:col-span-3">
            <div>
              <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">
                Discover
              </h3>
              <ul className="mt-4 space-y-3">
                {footerLinks.discover.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-sm text-foreground-muted hover:text-foreground transition-colors"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">
                More Genres
              </h3>
              <ul className="mt-4 space-y-3">
                {footerLinks.genres.map((link) => (
                  <li key={link.href}>
                    <Link
                      href={link.href}
                      className="text-sm text-foreground-muted hover:text-foreground transition-colors"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>

            <div>
              <h3 className="text-sm font-semibold text-foreground uppercase tracking-wider">
                Resources
              </h3>
              <ul className="mt-4 space-y-3">
                {footerLinks.resources.map((link) => (
                  <li key={link.label}>
                    <Link
                      href={link.href}
                      className="text-sm text-foreground-muted hover:text-foreground transition-colors"
                    >
                      {link.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </div>

        {/* Bottom bar */}
        <div className="mt-12 pt-8 border-t border-border">
          <div className="flex flex-col sm:flex-row justify-between items-center gap-4">
            <p className="text-sm text-foreground-subtle">
              &copy; {new Date().getFullYear()} Librarian. All rights reserved.
            </p>
            <p className="text-sm text-foreground-subtle flex items-center gap-1">
              Made with <Heart className="h-3.5 w-3.5 text-accent" /> for book
              lovers
            </p>
          </div>
        </div>
      </div>
    </footer>
  );
}
