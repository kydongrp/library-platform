import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Bulk import parses files in the browser and streams them to the server
    // in small row-chunks; this gives those Server Action calls headroom.
    serverActions: { bodySizeLimit: "4mb" },
  },
};

export default nextConfig;
