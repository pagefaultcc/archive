import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  output: "standalone",
  experimental: {
    proxyClientMaxBodySize: "100gb",
  },
  async rewrites() {
    // Fixed Compose service URL; browser Origin/Cookie and API Set-Cookie
    // headers pass through the proxy untouched.
    return [
      {
        source: "/api/:path*",
        destination: "http://api:8080/api/:path*",
      },
    ];
  },
};

export default nextConfig;
