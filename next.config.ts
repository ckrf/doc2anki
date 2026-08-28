import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  experimental: {
    // The UI accepts files up to 25 MB; leave room for multipart form metadata.
    serverActions: { bodySizeLimit: '30mb' },
  },
};

export default nextConfig;
