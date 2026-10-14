/** @type {import('next').NextConfig} */
const nextConfig = {
  // Next 14 needs this for instrumentation.ts (loads the local model into memory at server start)
  experimental: { instrumentationHook: true },
};
export default nextConfig;
