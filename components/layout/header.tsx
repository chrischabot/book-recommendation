"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, useEffect } from "react";
import { motion, AnimatePresence } from "motion/react";
import {
  BookOpen,
  Sparkles,
  Library,
  Menu,
  X,
  ChevronDown,
} from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";

const navLinks = [
  {
    href: "/recommendations",
    label: "For You",
    icon: Sparkles,
  },
  {
    href: "/categories",
    label: "Browse",
    icon: Library,
  },
];

const categoryQuickLinks = [
  { href: "/category/science-fiction", label: "Science Fiction" },
  { href: "/category/high-fantasy", label: "Fantasy" },
  { href: "/category/mystery", label: "Mystery" },
  { href: "/category/biography", label: "Biography" },
  { href: "/category/history", label: "History" },
  { href: "/category/science", label: "Science" },
];

export function Header() {
  const pathname = usePathname();
  const [isScrolled, setIsScrolled] = useState(false);
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [isCategoriesOpen, setIsCategoriesOpen] = useState(false);

  useEffect(() => {
    const handleScroll = () => {
      setIsScrolled(window.scrollY > 20);
    };

    window.addEventListener("scroll", handleScroll);
    return () => window.removeEventListener("scroll", handleScroll);
  }, []);

  // Close mobile menu on route change
  useEffect(() => {
    setIsMobileMenuOpen(false);
    setIsCategoriesOpen(false);
  }, [pathname]);

  return (
    <>
      <header
        className={cn(
          "fixed top-0 inset-x-0 z-50 transition-all duration-300",
          isScrolled
            ? "bg-background/95 backdrop-blur-md border-b border-border shadow-sm"
            : "bg-transparent"
        )}
      >
        <nav className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
          <div className="flex h-16 items-center justify-between">
            {/* Logo */}
            <Link
              href="/"
              className="flex items-center gap-2.5 group"
            >
              <div
                className={cn(
                  "flex items-center justify-center w-10 h-10 rounded-xl",
                  "bg-primary/10 group-hover:bg-primary/20 transition-colors",
                  "group-hover:scale-105 transition-transform duration-200"
                )}
              >
                <BookOpen className="h-5 w-5 text-primary" />
              </div>
              <div className="flex flex-col">
                <span className="font-display text-lg font-bold text-foreground leading-tight">
                  Librarian
                </span>
                <span className="text-[10px] text-foreground-subtle uppercase tracking-widest font-medium -mt-0.5">
                  Your Personal Guide
                </span>
              </div>
            </Link>

            {/* Desktop Navigation */}
            <div className="hidden md:flex items-center gap-1">
              {navLinks.map((link) => {
                const Icon = link.icon;
                const isActive = pathname === link.href || pathname.startsWith(link.href + "/");

                if (link.href === "/categories") {
                  return (
                    <div key={link.href} className="relative">
                      <button
                        onClick={() => setIsCategoriesOpen(!isCategoriesOpen)}
                        className={cn(
                          "relative flex items-center gap-2 px-4 py-2 rounded-lg",
                          "text-sm font-medium transition-all duration-200",
                          isActive || isCategoriesOpen
                            ? "text-foreground"
                            : "text-foreground-muted hover:text-foreground hover:bg-muted/50"
                        )}
                      >
                        <Icon className="h-4 w-4" />
                        {link.label}
                        <ChevronDown
                          className={cn(
                            "h-3.5 w-3.5 transition-transform duration-200",
                            isCategoriesOpen && "rotate-180"
                          )}
                        />
                        {(isActive || pathname.startsWith("/category/")) && (
                          <motion.div
                            layoutId="nav-indicator"
                            className="absolute bottom-0 left-4 right-4 h-0.5 bg-primary rounded-full"
                          />
                        )}
                      </button>

                      {/* Dropdown */}
                      <AnimatePresence>
                        {isCategoriesOpen && (
                          <motion.div
                            initial={{ opacity: 0, y: 8 }}
                            animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, y: 8 }}
                            transition={{ duration: 0.2 }}
                            className={cn(
                              "absolute top-full right-0 mt-2 w-56",
                              "bg-card rounded-xl border border-border shadow-lg",
                              "p-2"
                            )}
                          >
                            {categoryQuickLinks.map((cat) => (
                              <Link
                                key={cat.href}
                                href={cat.href}
                                className={cn(
                                  "block px-4 py-2.5 rounded-lg text-sm",
                                  "transition-colors duration-150",
                                  pathname === cat.href
                                    ? "bg-primary/10 text-primary font-medium"
                                    : "text-foreground-muted hover:bg-muted hover:text-foreground"
                                )}
                              >
                                {cat.label}
                              </Link>
                            ))}
                            <div className="my-2 h-px bg-border" />
                            <Link
                              href="/categories"
                              className="block px-4 py-2.5 rounded-lg text-sm text-primary font-medium hover:bg-primary/10 transition-colors"
                            >
                              View all categories &rarr;
                            </Link>
                          </motion.div>
                        )}
                      </AnimatePresence>
                    </div>
                  );
                }

                return (
                  <Link
                    key={link.href}
                    href={link.href}
                    className={cn(
                      "relative flex items-center gap-2 px-4 py-2 rounded-lg",
                      "text-sm font-medium transition-all duration-200",
                      isActive
                        ? "text-foreground"
                        : "text-foreground-muted hover:text-foreground hover:bg-muted/50"
                    )}
                  >
                    <Icon className="h-4 w-4" />
                    {link.label}
                    {isActive && (
                      <motion.div
                        layoutId="nav-indicator"
                        className="absolute bottom-0 left-4 right-4 h-0.5 bg-primary rounded-full"
                      />
                    )}
                  </Link>
                );
              })}
            </div>

            {/* CTA Button */}
            <div className="hidden md:block">
              <Button asChild>
                <Link href="/recommendations">
                  Get Started
                </Link>
              </Button>
            </div>

            {/* Mobile Menu Button */}
            <button
              onClick={() => setIsMobileMenuOpen(!isMobileMenuOpen)}
              className="md:hidden p-2 rounded-lg text-foreground-muted hover:text-foreground hover:bg-muted transition-colors"
            >
              {isMobileMenuOpen ? (
                <X className="h-6 w-6" />
              ) : (
                <Menu className="h-6 w-6" />
              )}
            </button>
          </div>
        </nav>

        {/* Mobile Menu */}
        <AnimatePresence>
          {isMobileMenuOpen && (
            <motion.div
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              transition={{ duration: 0.3 }}
              className="md:hidden border-t border-border bg-card overflow-hidden"
            >
              <div className="px-4 py-4 space-y-2">
                {navLinks.map((link) => {
                  const Icon = link.icon;
                  const isActive = pathname === link.href;

                  return (
                    <Link
                      key={link.href}
                      href={link.href}
                      className={cn(
                        "flex items-center gap-3 px-4 py-3 rounded-lg",
                        "text-base font-medium transition-colors",
                        isActive
                          ? "bg-primary/10 text-primary"
                          : "text-foreground-muted hover:bg-muted hover:text-foreground"
                      )}
                    >
                      <Icon className="h-5 w-5" />
                      {link.label}
                    </Link>
                  );
                })}

                <div className="pt-2 mt-2 border-t border-border">
                  <p className="px-4 py-2 text-xs font-medium text-foreground-subtle uppercase tracking-wider">
                    Quick Categories
                  </p>
                  {categoryQuickLinks.slice(0, 4).map((cat) => (
                    <Link
                      key={cat.href}
                      href={cat.href}
                      className={cn(
                        "block px-4 py-2.5 rounded-lg text-sm",
                        pathname === cat.href
                          ? "bg-primary/10 text-primary font-medium"
                          : "text-foreground-muted hover:bg-muted hover:text-foreground"
                      )}
                    >
                      {cat.label}
                    </Link>
                  ))}
                </div>

                <div className="pt-4">
                  <Button asChild className="w-full" size="lg">
                    <Link href="/recommendations">Get Recommendations</Link>
                  </Button>
                </div>
              </div>
            </motion.div>
          )}
        </AnimatePresence>
      </header>

      {/* Spacer for fixed header */}
      <div className="h-16" />

      {/* Click outside to close dropdown */}
      {isCategoriesOpen && (
        <div
          className="fixed inset-0 z-40"
          onClick={() => setIsCategoriesOpen(false)}
        />
      )}
    </>
  );
}
