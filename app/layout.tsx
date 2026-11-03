import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Fusion Music — музыка на стриме",
  description: "Музыкальные заявки сообщества Fusion.",
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body>{children}</body></html>;
}
