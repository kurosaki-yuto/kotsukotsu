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
              className="flex flex-col overflow-hidden rounded-[14px] border transition-colors hover:bg-[#f6f8fd] md:flex-row"
              style={{ borderColor: "#dce2ee" }}
            >
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={c.thumb} alt="" className="aspect-[1200/630] w-full flex-none object-cover md:w-[300px]" />
              <div className="p-5">
                <div className="text-[12px]" style={{ color: "#60697b" }}>{c.date}</div>
                <div className="mt-1 text-[17px] font-bold leading-snug">{c.title}</div>
                <div className="mt-1.5 text-[13.5px] leading-relaxed" style={{ color: "#3a4459" }}>{c.summary}</div>
              </div>
            </Link>
          </li>
        ))}
      </ul>
    </ColumnFrame>
  );
}
