import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "SolarOps · Energy intelligence",
  description:
    "Read-only solar energy management simulator. Monitor generation, battery, demand and grid power across sites.",
};
export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
