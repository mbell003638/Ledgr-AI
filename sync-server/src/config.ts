import { readFileSync } from "node:fs";

/** Read NAME or Docker/Kubernetes-style NAME_FILE without logging the secret. */
export function secretEnv(name: string): string | undefined {
  const direct = process.env[name]?.trim();
  if (direct) return direct;
  const file = process.env[`${name}_FILE`]?.trim();
  if (!file) return undefined;
  const value = readFileSync(file, "utf8").trim();
  if (!value) throw new Error(`${name}_FILE points to an empty secret`);
  return value;
}

export function integerEnv(name: string, fallback: number, minimum: number, maximum: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new Error(`${name} must be an integer between ${minimum} and ${maximum}`);
  return value;
}

export function requireHttpsUrl(name: string, value: string | undefined, production: boolean): string | undefined {
  if (!value) return undefined;
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(`${name} must be a valid URL`); }
  if (production && url.protocol !== "https:") throw new Error(`${name} must use HTTPS in production`);
  return url.toString();
}
