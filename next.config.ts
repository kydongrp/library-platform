import type { NextConfig } from "next";

// Everything this app loads is same-origin: fonts are self-hosted via
// next/font, there are no external scripts, images, or client-side API calls.
// 'unsafe-inline' stays because Next.js hydrates through inline scripts and
// styles; 'unsafe-eval' exists only in development builds (React refresh).
const csp = [
  "default-src 'self'",
  process.env.NODE_ENV === "development"
    ? "script-src 'self' 'unsafe-inline' 'unsafe-eval'"
    : "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const nextConfig: NextConfig = {
  // The framework fingerprint header serves no one but a scanner.
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=()" },
        ],
      },
    ];
  },
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
