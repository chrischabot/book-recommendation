import type { Metadata, Viewport } from "next";
import { Header } from "@/components/layout/header";
import { Footer } from "@/components/layout/footer";
import { TooltipProvider } from "@/components/ui/tooltip";
import "./globals.css";

export const metadata: Metadata = {
  title: {
    default: "Librarian - Your Personal Book Recommender",
    template: "%s | Librarian",
  },
  description:
    "Discover your next favorite book with AI-powered recommendations based on your reading history. Import from Goodreads or Kindle and get personalized suggestions.",
  keywords: [
    "book recommendations",
    "reading",
    "books",
    "AI recommendations",
    "Goodreads",
    "Kindle",
  ],
  authors: [{ name: "Librarian" }],
  openGraph: {
    type: "website",
    locale: "en_US",
    siteName: "Librarian",
  },
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#F9F6F1" },
    { media: "(prefers-color-scheme: dark)", color: "#1a1814" },
  ],
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className="scroll-smooth">
      <body className="min-h-screen flex flex-col antialiased">
        <TooltipProvider delayDuration={200}>
          <Header />
          <main className="flex-1">{children}</main>
          <Footer />
        </TooltipProvider>
      </body>
    </html>
  );
}
