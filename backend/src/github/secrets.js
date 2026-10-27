import crypto from "crypto";

// GitHub tokens are stored encrypted with AES-256-GCM. The key comes from
// GITHUB_TOKEN_ENCRYPTION_KEY (32 bytes as 64 hex chars or base64) at runtime,
// never from the image or the database. Each box is bound to its owner (AAD),
// so a ciphertext copied onto another user's record won't decrypt.

export const KEY_ENV = "GITHUB_TOKEN_ENCRYPTION_KEY";

export class SecretsConfigError extends Error {}

function loadKey() {
  const raw = (process.env[KEY_ENV] || "").trim();
  if (!raw) throw new SecretsConfigError(`${KEY_ENV} is not set`);
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new SecretsConfigError(`${KEY_ENV} must be 32 bytes (64 hex characters or base64)`);
  return key;
}

export function isEncryptionConfigured() {
  try {
    loadKey();
    return true;
  } catch {
    return false;
  }
}

const aad = (owner) => Buffer.from(`bugops:github-token:${owner}`);

export function encryptSecret(plaintext, owner) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", loadKey(), iv);
  cipher.setAAD(aad(owner));
  const data = Buffer.concat([cipher.update(String(plaintext), "utf8"), cipher.final()]);
  return { v: 1, iv: iv.toString("base64"), tag: cipher.getAuthTag().toString("base64"), data: data.toString("base64") };
}

// Throws if the key is wrong, the box was tampered with, or it belongs to someone else.
export function decryptSecret(box, owner) {
  if (box?.v !== 1) throw new Error("Unsupported secret format");
  const decipher = crypto.createDecipheriv("aes-256-gcm", loadKey(), Buffer.from(box.iv, "base64"));
  decipher.setAAD(aad(owner));
  decipher.setAuthTag(Buffer.from(box.tag, "base64"));
  return Buffer.concat([decipher.update(Buffer.from(box.data, "base64")), decipher.final()]).toString("utf8");
}
