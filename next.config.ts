import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  experimental: {
    // Bulk import parses files in the browser and streams them to the server
    // in small row-chunks; this gives those Server Action calls headroom.
    serverActions: { bodySizeLimit: "4mb" },
  },
  // ssh2-sftp-client (and its ssh2 dep) has native/optional bits, so keep it
  // out of the bundler and require it at runtime on the server instead.
  serverExternalPackages: ["ssh2", "ssh2-sftp-client"],
};

export default nextConfig;
