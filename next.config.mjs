/** @type {import('next').NextConfig} */
const nextConfig = {
  // better-sqlite3 is a native (C++) module. Tell Next NOT to bundle it, or it fails to load
  // inside route handlers. This is the single most common "it worked locally then broke" gotcha.
  experimental: {
    serverComponentsExternalPackages: ["better-sqlite3"],
  },
};

export default nextConfig;
