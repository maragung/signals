import type { Metadata, Viewport } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'Price Prediction Terminal',
  description:
    'Real-time technical analysis and deterministic price projection for BTC/USD, XAU/USD, ETH/USDT, ETH/BTC. No AI required at runtime.',
  applicationName: 'Price Prediction Terminal',
  manifest: '/manifest.json',
  appleWebApp: {
    capable: true,
    statusBarStyle: 'black-translucent',
    title: 'Price Terminal',
  },
};

export const viewport: Viewport = {
  width: 'device-width',
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
  themeColor: '#0b0e11',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" data-theme="dark" suppressHydrationWarning>
      <head>
        <link rel="icon" href="/favicon.svg" type="image/svg+xml" />
        <meta name="mobile-web-app-capable" content="yes" />
        <script
          dangerouslySetInnerHTML={{
            __html: `
              (function() {
                try {
                  var t = localStorage.getItem('pp-settings-v1');
                  if (t) {
                    var p = JSON.parse(t);
                    if (p && p.state && p.state.theme) {
                      document.documentElement.setAttribute('data-theme', p.state.theme);
                    }
                  }
                } catch (e) {}
              })();
            `,
          }}
        />
      </head>
      <body>{children}</body>
    </html>
  );
}
