import type { NextConfig } from "next";

const config: NextConfig = {
  async rewrites() {
    const backend = new URL(process.env.NEXT_PUBLIC_API_BASE_URL || "http://127.0.0.1:8000");
    if (!["http:", "https:"].includes(backend.protocol) || backend.href !== backend.origin + "/") {
      throw new Error("NEXT_PUBLIC_API_BASE_URL must be an HTTP(S) origin.");
    }
    return [{ source: "/api/v1/:path*", destination: backend.origin + "/api/v1/:path*" }];
  },
};

export default config;
