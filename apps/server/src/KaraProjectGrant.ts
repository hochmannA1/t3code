// @effect-diagnostics nodeBuiltinImport:off
import { createHmac, timingSafeEqual } from "node:crypto";

export type ProjectGrantRole = "read" | "edit";

export interface ProjectGrant {
  v: 1;
  shareId: string;
  projectId: string;
  subject: string;
  tenant: string;
  role: ProjectGrantRole;
  exp: number;
}

const TOKEN_PREFIX = "kara-project-grant-v1";
const GRANT_TTL_SECONDS = 30;
const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const GRANT_KEYS = ["v", "shareId", "projectId", "subject", "tenant", "role", "exp"] as const;

function validSecret(secret: unknown): secret is string {
  return typeof secret === "string" && secret.length >= 32;
}

function validText(value: unknown, maximum: number): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= maximum &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/u.test(value)
  );
}

function isProjectGrant(value: unknown): value is ProjectGrant {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const grant = value as Record<string, unknown>;
  if (
    Object.keys(grant).length !== GRANT_KEYS.length ||
    Object.keys(grant).some((key) => !GRANT_KEYS.includes(key as (typeof GRANT_KEYS)[number]))
  )
    return false;
  return (
    grant.v === 1 &&
    typeof grant.shareId === "string" &&
    UUID_V4.test(grant.shareId) &&
    validText(grant.projectId, 256) &&
    validText(grant.subject, 256) &&
    validText(grant.tenant, 128) &&
    (grant.role === "read" || grant.role === "edit") &&
    Number.isSafeInteger(grant.exp) &&
    (grant.exp as number) > 0
  );
}

function signature(value: string, secret: string): Buffer {
  return createHmac("sha256", secret).update(value, "utf8").digest();
}

export function signProjectGrant(
  payload: ProjectGrant,
  secret: string,
  nowSeconds: number,
): string {
  if (!validSecret(secret))
    throw new TypeError("Project grant secret must contain at least 32 characters");
  if (!isProjectGrant(payload)) throw new TypeError("Invalid project grant payload");
  if (
    !Number.isSafeInteger(nowSeconds) ||
    nowSeconds < 0 ||
    payload.exp <= nowSeconds ||
    payload.exp > nowSeconds + GRANT_TTL_SECONDS
  ) {
    throw new TypeError("Project grant expiration must be within 30 seconds");
  }
  const encoded = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const signed = `${TOKEN_PREFIX}.${encoded}`;
  return `${signed}.${signature(signed, secret).toString("base64url")}`;
}

export function verifyProjectGrant(
  token: string,
  secret: string,
  nowSeconds: number,
): ProjectGrant | null {
  if (
    !validSecret(secret) ||
    typeof token !== "string" ||
    token.length > 4096 ||
    !Number.isSafeInteger(nowSeconds) ||
    nowSeconds < 0
  )
    return null;
  const parts = token.split(".");
  if (parts.length !== 3 || parts[0] !== TOKEN_PREFIX) return null;
  const [, encoded, encodedSignature] = parts;
  if (
    !encoded ||
    !/^[A-Za-z0-9_-]+$/u.test(encoded) ||
    !encodedSignature ||
    !/^[A-Za-z0-9_-]+$/u.test(encodedSignature)
  )
    return null;
  try {
    const payloadBytes = Buffer.from(encoded, "base64url");
    if (payloadBytes.toString("base64url") !== encoded) return null;
    const payload: unknown = JSON.parse(payloadBytes.toString("utf8"));
    if (
      !isProjectGrant(payload) ||
      payload.exp <= nowSeconds ||
      payload.exp > nowSeconds + GRANT_TTL_SECONDS
    )
      return null;
    const suppliedSignature = Buffer.from(encodedSignature, "base64url");
    if (suppliedSignature.toString("base64url") !== encodedSignature) return null;
    const signed = `${TOKEN_PREFIX}.${encoded}`;
    const expectedSignature = signature(signed, secret);
    if (
      suppliedSignature.length !== expectedSignature.length ||
      !timingSafeEqual(suppliedSignature, expectedSignature)
    )
      return null;
    return { ...payload };
  } catch {
    return null;
  }
}
