import type { Metadata } from "next";
import localFont from "next/font/local";
import "./globals.css";
import { Toaster } from "@/app/components/ui/sonner";
import { TooltipProvider } from "@/app/components/ui/tooltip";
import { AuthFetch } from "@/app/components/auth-fetch";
import { HelpOverlay } from "@/app/components/HelpOverlay";
import { CommandPalette } from "@/app/components/CommandPalette";

const geistSans = localFont({
  src: "./fonts/GeistVF.woff",
  variable: "--font-sans",
  display: "swap",
});

const geistMono = localFont({
  src: "./fonts/GeistMonoVF.woff",
  variable: "--font-mono",
  display: "swap",
});

export const metadata: Metadata = {
  title: "OpenAcme — AI Agent Platform",
  description:
    "Multi-LLM agent platform with tool calling, MCP support, and multi-agent orchestration.",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <head>
        {/*
         * Set the dark class before first paint so SSR + theme stay in sync
         * and the user doesn't see a flash. Reads localStorage; falls back
         * to system preference. Mirrors logic in components/ThemeToggle.tsx.
         */}
        <script
          dangerouslySetInnerHTML={{
            __html: `(function(){try{var k='openacme.theme';var c=localStorage.getItem(k);var s=window.matchMedia('(prefers-color-scheme: dark)').matches;var d=c==='dark'||((c==null||c==='system')&&s);document.documentElement.classList.toggle('dark',d);}catch(e){}})();`,
          }}
        />
      </head>
      <body
        className={`${geistSans.variable} ${geistMono.variable} bg-background text-foreground antialiased paper-surface`}
      >
        <TooltipProvider delayDuration={200}>
          <AuthFetch />
          {children}
          <HelpOverlay />
          <CommandPalette />
          <Toaster />
        </TooltipProvider>
      </body>
    </html>
  );
}
