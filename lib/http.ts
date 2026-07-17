import type { VercelRequest } from '@vercel/node';

export function getBaseUrl(request: VercelRequest): string {
  const protocolHeader = request.headers['x-forwarded-proto'];
  const hostHeader = request.headers['x-forwarded-host'] || request.headers.host;

  const protocol = Array.isArray(protocolHeader)
    ? protocolHeader[0]
    : protocolHeader || 'https';
  const host = Array.isArray(hostHeader) ? hostHeader[0] : hostHeader;

  if (!host) {
    return process.env.PUBLIC_BASE_URL || 'https://trackme.shvms.in';
  }

  return `${protocol}://${host}`;
}

export function absoluteUrl(request: VercelRequest, path: string): string {
  if (/^https?:\/\//i.test(path)) return path;
  return `${getBaseUrl(request)}${path.startsWith('/') ? path : `/${path}`}`;
}
