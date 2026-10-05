import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import ColumnBody from "../../components/ColumnBody";
import { COLUMNS, findColumn } from "../../lib/columns";
import ColumnFrame from "../ColumnFrame";
import OfficialOnly from "../OfficialOnly";

export function generateStaticParams() {
  return COLUMNS.map((c) => ({ slug: c.slug }));
}

export async function generateMetadata({ params }: { params: Promise<{ slug: string }> }): Promise<Metadata> {
  const c = findColumn((await params).slug);
  if (!c) return { title: "コラム | こつこつ" };
  return { title: `${c.title} | こつこつ`, description: c.summary, openGraph: { title: c.title, description: c.summary } };
}

export default async function ColumnPage({ params }: { params: Promise<{ slug: string }> }) {
  const c = findColumn((await params).slug);
  if (!c) notFound();
  return (
    <ColumnFrame>
      <Link href="/column" className="text-[13px] underline underline-offset-2" style={{ color: "#60697b" }}>
        コラム一覧
      </Link>
      <article className="mt-5">
        {/* eslint-disable-next-line @next/next/no-img-element */}
        <img src={c.thumb} alt="" className="mb-6 aspect-[1200/630] w-full rounded-[14px] object-cover" style={{ border: "1px solid #dce2ee" }} />
        <div className="text-[12.5px]" style={{ color: "#60697b" }}>{c.date}</div>
        <h1 className="mt-1.5 text-[24px] font-bold leading-snug md:text-[28px]">{c.title}</h1>
        <p className="mt-3 text-[14.5px] leading-relaxed" style={{ color: "#3a4459" }}>{c.summary}</p>
        <div className="mt-8">
          <ColumnBody body={c.body} />
        </div>
      </article>
      <OfficialOnly>
      <div className="mt-12 rounded-[14px] p-6" style={{ background: "#eef3ff" }}>
        <div className="text-[15px] font-bold">こつこつを使ってみる</div>
        <p className="mt-1.5 text-[13.5px] leading-relaxed" style={{ color: "#3a4459" }}>
          ゴールとタスクをAIが読み書きするToDoです。登録すると、設定の「連携ガイド」からAIの繋ぎ方を順に試せます。
        </p>
        <a href="/login?signup=1" className="mt-4 inline-block rounded-full px-5 py-2 text-[13.5px] font-bold text-white" style={{ background: "#1d3b9e" }}>
          はじめる
        </a>
      </div>
      </OfficialOnly>
    </ColumnFrame>
  );
}
