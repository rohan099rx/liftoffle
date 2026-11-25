import type { Metadata, Viewport } from "next";
import { Analytics } from "@vercel/analytics/next";
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

export const metadata: Metadata = {
  // Absolute base for link-preview images. Set SITE_URL (e.g. https://liftoffle.com) once the domain is connected.
  metadataBase: new URL(process.env.SITE_URL || (process.env.VERCEL_ENV === "production" ? "https://liftoffle.vercel.app"
    : process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : "http://localhost:3000")),
  title: "Liftoffle · name the thing nobody else will",
  applicationName: "Liftoffle",
  description: "Seven prompts a day. Rare answers launch you higher. Obvious ones barely leave the pad.",
  openGraph: { title: "Liftoffle · the daily rare-answer word game", description: "Name the thing nobody else will. Play solo or race your friends.", type: "website", siteName: "Liftoffle" },
  twitter: { card: "summary_large_image", title: "Liftoffle · the daily rare-answer word game", description: "Name the thing nobody else will. Play solo or race your friends." },
};
const sans = Geist({ subsets: ["latin"], variable: "--font-sans", display: "swap" });
const mono = Geist_Mono({ subsets: ["latin"], variable: "--font-mono", display: "swap" });

export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#05060f" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return <html lang="en" className={`${sans.variable} ${mono.variable}`}><body>{children}<Analytics /></body></html>;
}
