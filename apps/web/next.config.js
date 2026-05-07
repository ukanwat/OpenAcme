/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "export",
  distDir: "out",
  // Disable image optimization for static export
  images: {
    unoptimized: true,
  },
};

export default nextConfig;
