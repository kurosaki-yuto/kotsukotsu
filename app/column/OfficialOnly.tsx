"use client";

import type * as React from "react";
import { useEffect, useState } from "react";
import { isOfficialHost } from "../lib/hosts";

// 当社ホスト版 (kotukotu.app) でだけ出す部分。コラムの「はじめる」(新規登録) など。
// 自社専用版はコラムも公開ページとして持つが、招待制のこともあり、当社の登録の案内は要らない。
export default function OfficialOnly({ children }: { children: React.ReactNode }) {
  const [show, setShow] = useState(false);
  useEffect(() => setShow(isOfficialHost(window.location.host)), []);
  return show ? <>{children}</> : null;
}
