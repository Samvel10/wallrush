import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'org.wallrush.app',
  appName: 'WallRush',
  webDir: 'packages/client/dist',
  server: {
    // Keep the native WebView on a secure origin so browser APIs behave like
    // they do on the HTTPS website.
    androidScheme: 'https',
  },
};

export default config;
