import "server-only";
import { platformEnv } from "@/app/lib/server/platform";

// The R2 bucket binding (kotsukotsu-files) for resource file uploads.
export function bucket(): R2Bucket | null {
  const env = platformEnv() as unknown as { FILES?: R2Bucket };
  return env.FILES ?? null;
}

// Sanitize a filename for use inside an object key. 日本語の名前は残す (ダウンロード時の名前はキーから取るため)。
// / や .. などキーの区切りになる文字・制御文字は _ にする。
export function safeName(name: string): string {
  return (name || "file").normalize("NFC").replace(/[^\p{L}\p{N}._\-]+/gu, "_").replace(/^\.+/, "_").slice(0, 80);
}
