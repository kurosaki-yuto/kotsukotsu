// 新規登録した人がどこから来たかを残すための、最初に開いたページの記録。
// タブで最初に開いたページで1回だけ、参照元のドメイン (別のサイトから来たときだけ)・utm・パスを
// sessionStorage に置く。登録画面がそれを読んで /api/auth/register に一緒に送る。
// Cookie は使わず、タブを閉じると消える。全文の URL は残さない (ドメインだけ)。
// 紹介ページ (public/introduction.html) は Next を通らないので、同じ中身を直に書いてある。直すときは両方直す。
export const FIRST_TOUCH_KEY = "kk_ft";

export const FIRST_TOUCH_SCRIPT = `(function(){try{var k="kk_ft";if(sessionStorage.getItem(k))return;var r="";try{var u=new URL(document.referrer);if(u.host!==location.host)r=u.host}catch(e){}var p=new URLSearchParams(location.search);sessionStorage.setItem(k,JSON.stringify({ref:r,us:p.get("utm_source")||"",um:p.get("utm_medium")||"",uc:p.get("utm_campaign")||"",lp:location.pathname}))}catch(e){}})();`;

export type SignupSource = { ref: string; utmSource: string; utmMedium: string; utmCampaign: string; landing: string };

// 送られてきた値は信用しない。文字列だけ・長さを切って受け取る。何も入っていなければ null
export function parseSignupSource(raw: unknown): SignupSource | null {
  if (typeof raw !== "string" || raw.length > 2000) return null;
  let v: Record<string, unknown>;
  try {
    v = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const s = (x: unknown) => (typeof x === "string" ? x.trim().slice(0, 200) : "");
  const out = { ref: s(v.ref), utmSource: s(v.us), utmMedium: s(v.um), utmCampaign: s(v.uc), landing: s(v.lp) };
  return Object.values(out).some(Boolean) ? out : null;
}
