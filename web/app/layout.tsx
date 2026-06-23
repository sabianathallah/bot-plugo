import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'PLUGO MONITOR',
  description: 'Realtime stock monitor for Plugo streetwear stores',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
