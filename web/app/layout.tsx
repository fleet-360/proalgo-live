import type { Metadata, Viewport } from "next";
import { Heebo } from "next/font/google";
import "./globals.css";

const heebo = Heebo({
  subsets: ["hebrew", "latin"],
  weight: ["400", "500", "700", "800", "900"],
  variable: "--font-heebo",
});

export const metadata: Metadata = {
  title: "תוכנית עבודה | Pro Algorithm",
  description: "תוכנית עבודה שנבנית בזמן אמת במהלך השיחה",
  robots: { index: false, follow: false },
};

export const viewport: Viewport = {
  themeColor: "#0b1040",
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="he" dir="rtl" className={heebo.variable}>
      <body>{children}</body>
    </html>
  );
}
