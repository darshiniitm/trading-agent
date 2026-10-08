import "./globals.css";
import { IBM_Plex_Sans, IBM_Plex_Mono } from "next/font/google";
import { AuthGate } from "@/components/AuthGate";
import { AppShell } from "@/ui/AppShell";
import { Providers } from "./providers";

const sans = IBM_Plex_Sans({ subsets: ["latin"], weight: ["400", "500", "600", "700"], variable: "--font-plex-sans", display: "swap" });
const mono = IBM_Plex_Mono({ subsets: ["latin"], weight: ["400", "500", "600"], variable: "--font-plex-mono", display: "swap" });

export const metadata = { title: "Prompt Screener" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${sans.variable} ${mono.variable}`}>
      <body>
        <Providers>
          <AuthGate>
            <AppShell>{children}</AppShell>
          </AuthGate>
        </Providers>
      </body>
    </html>
  );
}
