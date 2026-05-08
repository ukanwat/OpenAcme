/** @type {import('next').NextConfig} */
const isDev = process.env.NODE_ENV !== "production";

// In `next dev` we proxy /api/* to the Hermes server on :3210 so the frontend
// can stay same-origin (matches production, where Hermes serves the static
// export). `output: "export"` is incompatible with `rewrites`, so it's only
// applied for the production build.
const nextConfig = {
  images: { unoptimized: true },
  ...(isDev
    ? {
        async rewrites() {
          const target = process.env.OPENACME_API_URL || "http://127.0.0.1:3210";
          return [{ source: "/api/:path*", destination: `${target}/api/:path*` }];
        },
      }
    : { output: "export", distDir: "out" }),
};

export default nextConfig;
