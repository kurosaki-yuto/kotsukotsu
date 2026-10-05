import type { Metadata } from "next";
import Link from "next/link";
import { COLUMNS } from "../lib/columns";
import ColumnFrame from "./ColumnFrame";

export const metadata: Metadata = {
  title: "コラム | こつこつ",
  description: "こつこつとAIの繋ぎ方、現状の書き方、連携のおすすめをまとめたコラム。",
};

export default function ColumnIndex() {
  return (
    <ColumnFrame>
      <h1 className="text-[26px] font-bold leading-snug md:text-[30px]">コラム</h1>
      <p className="mt-2 text-[14px] leading-relaxed" style={{ color: "#60697b" }}>
        こつこつとAIの繋ぎ方、使い方のコツをまとめています。
      </p>
      <ul className="mt-8 flex flex-col gap-4">
        {COLUMNS.map((c) => (
          <li key={c.slug}>
            <Link
              href={`/column/${c.slug}`}
              className="block rounded-[14px] border p-5 transition-colors hover:bg-[#f6f8fd]"
              style={{ borderColor: "#dce2ee" }}
            >
              <div className="text-[12px]" style={{ color: "#60697b" }}>{c.date}</div>
              <div className="mt-1 text-[17px] font-bold leading-snug">{c.title}</div>
              <div className="mt-1.5 text-[13.5px] leading-relaxed" style={{ color: "#3a4459" }}>{c.summary}</div>
            </Link>
          </li>
        ))}
      </ul>
    </ColumnFrame>
  );
}
