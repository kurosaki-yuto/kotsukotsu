"use client";

import { useEffect, useRef, type ComponentProps } from "react";

// 中身に合わせて高さが伸びる textarea (内側にスクロールバーを出さない)。
// 中身が後から読み込まれる・画面幅が変わる と高さも変わるので、そのたびに測り直す。
export default function AutoGrowTextarea({ minRows = 3, style, onInput, ...rest }: ComponentProps<"textarea"> & { minRows?: number }) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.max(el.scrollHeight, minRows * 24)}px`;
  };
  useEffect(() => { fit(); }, [rest.value]);
  useEffect(() => {
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, []);
  return (
    <textarea
      ref={ref}
      {...rest}
      onInput={(e) => { fit(); onInput?.(e); }}
      style={{ overflow: "hidden", resize: "none", ...style }}
    />
  );
}
