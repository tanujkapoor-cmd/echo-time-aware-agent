import type { NextConfig } from "next";

const config: NextConfig = {
  agentRules: false,
  devIndicators: false,
  turbopack: { root: process.cwd() },
  async rewrites() {
    const configured = process.env.NEXT_PUBLIC_API_BASE_URL;
    if (process.env.VERCEL_ENV === "production" && !configured) {
      throw new Error("Set NEXT_PUBLIC_API_BASE_URL to the deployed Echo API origin.");
    }
    const backend = new URL(configured || "http://127.0.0.1:8000");
    if (!["http:", "https:"].includes(backend.protocol) || backend.href !== backend.origin + "/") {
      throw new Error("NEXT_PUBLIC_API_BASE_URL must be an HTTP(S) origin.");
    }
    return [{ source: "/api/v1/:path*", destination: backend.origin + "/api/v1/:path*" }];
  },
};

export default config;
