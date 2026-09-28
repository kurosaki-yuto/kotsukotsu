"use client";

import { useEffect } from "react";
import { registerSW } from "../lib/push-client";

// Registers the service worker so the app is installable and can receive push.
export default function PWARegister() {
  useEffect(() => {
    void registerSW();
  }, []);
  return null;
}
