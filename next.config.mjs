/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  poweredByHeader: false,
  serverExternalPackages: ["argon2"],
  experimental: { serverActions: { bodySizeLimit: "3mb" } }, // upload de extrato (limite real de 2 MB validado no servidor)
};
export default nextConfig;
