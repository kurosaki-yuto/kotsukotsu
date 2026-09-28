import "server-only";
import { platformEnv } from "@/app/lib/server/platform";

// The R2 bucket binding (kotsukotsu-files) for resource file uploads.
export function bucket(): R2Bucket | null {
  const env = platformEnv() as unknown as { FILES?: R2Bucket };
  return env.FILES ?? null;
}

// Sanitize a filename for use inside an object key.
export function safeName(name: string): string {
  return (name || "file").replace(/[^\w.\-]+/g, "_").slice(0, 80);
}
