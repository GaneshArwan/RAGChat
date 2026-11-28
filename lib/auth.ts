import crypto from "crypto";
import { normalizeRoles } from "./security";

export interface JwtClaims {
  sub: string;
  tenantId: string;
  roles: string[];
  iat: number;
  exp: number;
}

export interface AuthContext {
  tenantId: string;
  roles: string[];
  subject: string;
  authMode: "jwt-verified" | "byok-dev";
}

function base64UrlEncode(input: Buffer | string): string {
  return Buffer.from(input)
    .toString("base64")
    .replace(/=/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function base64UrlDecode(input: string): Buffer {
  const padded = input.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (input.length % 4)) % 4);
  return Buffer.from(padded, "base64");
}

export function signSessionJwt(
  payload: { sub: string; tenantId: string; roles: string[] },
  secret: string,
  ttlSeconds: number = 3600
): string {
  const now = Math.floor(Date.now() / 1000);
  const claims: JwtClaims = {
    sub: payload.sub,
    tenantId: payload.tenantId || "default",
    roles: normalizeRoles(payload.roles),
    iat: now,
    exp: now + ttlSeconds,
  };
  const header = base64UrlEncode(JSON.stringify({ alg: "HS256", typ: "JWT" }));
  const body = base64UrlEncode(JSON.stringify(claims));
  const sig = base64UrlEncode(crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest());
  return `${header}.${body}.${sig}`;
}

export function verifySessionJwt(token: string, secret: string): JwtClaims | null {
  try {
    const parts = token.split(".");
    if (parts.length !== 3) return null;
    const [header, body, sig] = parts;
    const expected = base64UrlEncode(crypto.createHmac("sha256", secret).update(`${header}.${body}`).digest());
    const a = Buffer.from(sig);
    const b = Buffer.from(expected);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;

    const claims = JSON.parse(base64UrlDecode(body).toString("utf8")) as JwtClaims;
    if (!claims || typeof claims.exp !== "number" || claims.exp < Math.floor(Date.now() / 1000)) {
      return null;
    }
    return {
      sub: String(claims.sub || "anonymous"),
      tenantId: String(claims.tenantId || "default").replace(/[^a-zA-Z0-9_-]/g, "") || "default",
      roles: normalizeRoles(claims.roles),
      iat: Number(claims.iat || 0),
      exp: claims.exp,
    };
  } catch {
    return null;
  }
}

/**
 * Resolves tenant and RBAC identity.
 * When RAGCHAT_JWT_SECRET is configured, strictly enforces server-signed JWT claims
 * and ignores client-supplied tenant/role spoofing.
 */
export function resolveAuthContext(
  req: Request,
  clientTenantId?: string,
  clientRoles?: string[] | string
): AuthContext | null {
  const jwtSecret = process.env.RAGCHAT_JWT_SECRET;
  const authHeader = req.headers.get("authorization") || "";
  const bearerMatch = authHeader.match(/^Bearer\s+(.+)$/i);
  const token = bearerMatch?.[1]?.trim() || req.headers.get("x-ragchat-token")?.trim();

  if (jwtSecret) {
    if (!token) return null;
    const claims = verifySessionJwt(token, jwtSecret);
    if (!claims) return null;
    return {
      tenantId: claims.tenantId,
      roles: claims.roles,
      subject: claims.sub,
      authMode: "jwt-verified",
    };
  }

  return {
    tenantId: (clientTenantId || "default").replace(/[^a-zA-Z0-9_-]/g, "") || "default",
    roles: normalizeRoles(clientRoles),
    subject: "byok-user",
    authMode: "byok-dev",
  };
}
