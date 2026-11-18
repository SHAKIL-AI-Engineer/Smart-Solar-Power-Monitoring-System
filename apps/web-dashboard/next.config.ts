import type { NextConfig } from "next";
const config: NextConfig = {
  poweredByHeader: false,
  async rewrites() {
    if (process.env.SOLAR_BACKEND === "cloud") return [];
    const api = process.env.API_URL || "http://127.0.0.1:5080";
    return [
      { source: "/api/:path*", destination: `${api}/api/:path*` },
      { source: "/hubs/:path*", destination: `${api}/hubs/:path*` },
    ];
  },
};
export default config;
