import type { Metadata } from 'next';
import './globals.css';

const siteOrigin = process.env.SITE_URL;
const socialImage = siteOrigin ? new URL('/og.png', siteOrigin).toString() : undefined;

export const metadata: Metadata = {
  title: 'Doc2Anki — Flashcard Studio',
  description: 'Turn your source material into editable, Anki-ready flashcards.',
  openGraph: {
    title: 'Doc2Anki — Flashcard Studio',
    description: 'From source material to editable, Anki-ready flashcards.',
    type: 'website',
    images: socialImage ? [{ url: socialImage, width: 1672, height: 941, alt: 'Doc2Anki' }] : [],
  },
  twitter: {
    card: 'summary_large_image',
    title: 'Doc2Anki — Flashcard Studio',
    description: 'From source material to editable, Anki-ready flashcards.',
    images: socialImage ? [socialImage] : [],
  },
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
