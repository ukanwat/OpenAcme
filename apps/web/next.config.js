/** @type {import('next').NextConfig} */
const isDev = process.env.NODE_ENV !== "production";

// Dev: Hono on :3210 fronts both API + UI and proxies non-/api/* here, so the
// browser only sees one origin and same-origin /api/* calls just work. No
// rewrites needed. Production: static export served by Hono.
const nextConfig = {
  images: { unoptimized: true },
  ...(isDev ? {} : { output: "export", distDir: "out" }),
};

export default nextConfig;
