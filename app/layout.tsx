import type { Metadata } from "next";
import { headers } from "next/headers";
import { DM_Sans, IBM_Plex_Mono, Lora } from "next/font/google";
import "./globals.css";

const dmSans = DM_Sans({
  variable: "--font-sans",
  subsets: ["latin"],
});

const plexMono = IBM_Plex_Mono({
  variable: "--font-mono",
  subsets: ["latin"],
  weight: ["400", "500", "600"],
});

const lora = Lora({
  variable: "--font-serif",
  subsets: ["latin"],
});

export async function generateMetadata(): Promise<Metadata> {
  const requestHeaders = await headers();
  const host = requestHeaders.get("x-forwarded-host") ?? requestHeaders.get("host");
  const protocol = requestHeaders.get("x-forwarded-proto") ?? "https";
  const metadataBase = host ? new URL(`${protocol}://${host}`) : new URL("http://localhost:3000");

  return {
    metadataBase,
    title: "SignalCast — Research, distilled daily",
    description:
      "Discover important research, track emerging technology, and turn trusted sources into evidence-grounded podcasts.",
    icons: {
      icon: "/podcast-cover.png",
      shortcut: "/podcast-cover.png",
    },
    openGraph: {
      title: "SignalCast — Research, distilled daily",
      description:
        "A personal research intelligence and podcast studio.",
      images: [{ url: "/og.png", width: 1200, height: 630, alt: "SignalCast research intelligence dashboard" }],
    },
    twitter: {
      card: "summary_large_image",
      title: "SignalCast — Research, distilled daily",
      description: "A personal research intelligence and podcast studio.",
      images: ["/og.png"],
    },
  };
}

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body
        className={`${dmSans.variable} ${plexMono.variable} ${lora.variable}`}
      >
        {children}
      </body>
    </html>
  );
}
