import "server-only";
import { getCloudflareContext } from "@opennextjs/cloudflare";

// The R2 bucket binding (kotsukotsu-files) for resource file uploads.
export function bucket(): R2Bucket | null {
  const env = getCloudflareContext().env as unknown as { FILES?: R2Bucket };
  return env.FILES ?? null;
}

// Sanitize a filename for use inside an object key.
export function safeName(name: string): string {
  return (name || "file").replace(/[^\w.\-]+/g, "_").slice(0, 80);
}
