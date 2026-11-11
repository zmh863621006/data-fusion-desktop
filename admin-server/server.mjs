import { createAdminServer } from './app.mjs';

const port = Number(process.env.ADMIN_PORT ?? 8787);
const host = process.env.ADMIN_HOST ?? '127.0.0.1';
const allowHttp = process.env.ADMIN_ALLOW_INSECURE_HTTP === 'true';
const managementPublic = process.env.ADMIN_MANAGEMENT_PUBLIC === 'true';
if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error('ADMIN_PORT 无效');
if (process.env.NODE_ENV === 'production' && !allowHttp && process.env.ADMIN_COOKIE_SECURE !== 'true') {
  throw new Error('生产环境必须使用 HTTPS 并设置 ADMIN_COOKIE_SECURE=true');
}
if (process.env.NODE_ENV === 'production') {
  const origin = new URL(process.env.ADMIN_PUBLIC_ORIGIN ?? 'http://invalid');
  if (origin.protocol !== (allowHttp ? 'http:' : 'https:') || origin.origin !== process.env.ADMIN_PUBLIC_ORIGIN || origin.username || origin.password) throw new Error('生产环境 ADMIN_PUBLIC_ORIGIN 协议或源地址无效');
  const hasManagementIps = (process.env.ADMIN_MANAGEMENT_ALLOWED_IPS ?? '').split(',').some(value=>value.trim());
  if (allowHttp && (process.env.ADMIN_COOKIE_SECURE !== 'false' || (!managementPublic && !hasManagementIps))) throw new Error('显式 HTTP 部署必须设置 ADMIN_COOKIE_SECURE=false，并配置管理 IP 或明确设置 ADMIN_MANAGEMENT_PUBLIC=true');
  if (!process.env.ADMIN_DB_PATH || !process.env.ADMIN_LICENSE_PRIVATE_KEY) throw new Error('生产环境必须明确配置 ADMIN_DB_PATH 和 ADMIN_LICENSE_PRIVATE_KEY');
}
const server = createAdminServer();
server.listen(port, host, () => console.log(`授权管理后台：http://${host}:${port}`));
for (const event of ['SIGINT', 'SIGTERM']) process.on(event, () => {
  server.close(()=>process.exit(0));
  setTimeout(()=>process.exit(1),15_000).unref();
});
