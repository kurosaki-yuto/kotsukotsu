import { json } from "../../../lib/server/db";
import { vapidPublicKey } from "../../../lib/server/push";

// Public VAPID key the browser needs to create a push subscription.
export async function GET() {
  return json({ key: vapidPublicKey() });
}
