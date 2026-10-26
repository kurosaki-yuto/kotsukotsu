/**
 * claude.ai カスタムコネクタ用の最小 OAuth 2.1 (動的クライアント登録 + PKCE)。
 *
 * なぜ要るか: /mcp がキー無し・キー違いで 401 を返すと、claude.ai は OAuth に切り替えて
 * /.well-known/oauth-* → /register (動的クライアント登録) を叩きに来る。ここが 404 だと
 * 「サインインサービスに登録できませんでした … OAuth Client ID を追加してください」で止まる。
 *
 * やっていること:
 *   - 画面は出さない。claude.ai が /authorize に付けてくる resource (= 登録した接続URL
 *     /mcp/<APIキー>) から APIキーを取り出し、既存の resolveAuth で検証してそのまま承認する。
 *     resource にキーが無い時は、このブラウザで こつこつ にログインしている本人のキーで承認する
 *     (未ログインなら こつこつ のログイン画面を経由する)
 *   - 発行するアクセストークンは その APIキー そのもの。/mcp は Bearer でそれを受け取るので、
 *     接続後の権限 (ワークスペース・メンバーの範囲) は /mcp/<APIキー> で繋いだ時と完全に同じ
 *   - 状態は持たない。認可コードとリフレッシュトークンは OAUTH_SECRET から導いた鍵で AES-GCM 暗号化した
 *     自己完結トークンにする (D1 にテーブルを足さない)
 *
 * /mcp/<正しいAPIキー> で繋ぐ既存の接続は 401 にならないので、この経路を通らない。
 */

type Validate = (apiKey: string) => Promise<boolean>;
/** ブラウザの こつこつ ログイン (cookie sid) から、その人の APIキーを引く。未ログインなら null。 */
type SessionKey = (req: Request) => Promise<string | null>;

const CODE_TTL_SEC = 300;
// 認可 (/authorize) はアプリ本体のアドレス (kotukotu.app) で受ける。こつこつのログイン
// cookie (sid) はここにしか無いので、mcp.kotukotu.app で受けるとログイン済みでも毎回
// ログイン画面になる。
const APP_ORIGIN = "https://kotukotu.app";
const authorizeOrigin = (origin: string) => (new URL(origin).hostname.endsWith("kotukotu.app") ? APP_ORIGIN : origin);
// issuer は mcp.kotukotu.app に固定する。/authorize だけ別ドメインなので、戻り先に iss を付けて
// (RFC 9207) どの認可サーバーの応答かをクライアントが確かめられるようにする。Codex は
// これが無いと「authorization endpoint origin does not match」で止まる (2026-10-26)。
const MCP_ORIGIN = "https://mcp.kotukotu.app";
const issuerOrigin = (origin: string) => (new URL(origin).hostname.endsWith("kotukotu.app") ? MCP_ORIGIN : origin);

/** 認可コードを返してよい redirect_uri。claude.ai / claude.com のコールバックと、
 *  Claude Desktop のアプリ内スキーム、Claude Code が使うループバック (ポートは毎回変わる) だけ。 */
function redirectAllowed(uri: string): boolean {
  let u: URL;
  try {
    u = new URL(uri);
  } catch {
    return false;
  }
  // パスまでは絞らない。claude.ai のコールバックのパスは固定ではなかった
  // (2026-09-24 /api/mcp/auth_callback 決め打ちで弾いてしまった)。
  const claudeHost = (h: string) => h === "claude.ai" || h === "claude.com" || h.endsWith(".claude.ai") || h.endsWith(".claude.com");
  if (u.protocol === "https:" && claudeHost(u.hostname)) return true;
  // Claude Desktop のアプリ内コールバック
  if (u.protocol === "claude:") return true;
  return u.protocol === "http:" && (u.hostname === "localhost" || u.hostname === "127.0.0.1" || u.hostname === "[::1]");
}

// ---- 自己完結トークン (AES-GCM) -------------------------------------------

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
function unb64url(s: string): Uint8Array {
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
  return Uint8Array.from(bin, (c) => c.charCodeAt(0));
}

async function sealKey(secret: string): Promise<CryptoKey> {
  const raw = await crypto.subtle.digest("SHA-256", new TextEncoder().encode("kotsukotsu-oauth:" + secret));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
async function seal(secret: string, data: unknown): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await sealKey(secret), new TextEncoder().encode(JSON.stringify(data)))
  );
  const out = new Uint8Array(iv.length + ct.length);
  out.set(iv);
  out.set(ct, iv.length);
  return b64url(out);
}
async function unseal<T>(secret: string, token: string): Promise<T | null> {
  try {
    const buf = unb64url(token);
    const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: buf.slice(0, 12) }, await sealKey(secret), buf.slice(12));
    return JSON.parse(new TextDecoder().decode(pt)) as T;
  } catch {
    return null;
  }
}

async function s256(verifier: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier))));
}

/** client_id に封じた登録済み redirect_uris。封じていない (古い/外部の) client_id なら null。 */
async function registeredUris(secret: string, clientId: string): Promise<string[] | null> {
  if (!clientId.startsWith("kk_")) return null;
  const p = await unseal<{ u?: unknown }>(secret, clientId.slice(3));
  return p && Array.isArray(p.u) ? p.u.filter((x): x is string => typeof x === "string") : null;
}

// ---- responses -------------------------------------------------------------

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Authorization, Content-Type, Mcp-Protocol-Version",
};
function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store", ...CORS },
  });
}
function oauthError(error: string, description: string, status = 400): Response {
  return json({ error, error_description: description }, status);
}

/** 401 に付ける WWW-Authenticate。クライアントはここから保護リソースメタデータを辿る。 */
export function wwwAuthenticate(origin: string): string {
  return `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`;
}

export function isOAuthPath(pathname: string): boolean {
  return (
    pathname.startsWith("/.well-known/oauth-protected-resource") ||
    pathname.startsWith("/.well-known/oauth-authorization-server") ||
    pathname.startsWith("/.well-known/openid-configuration") ||
    pathname === "/register" ||
    pathname === "/authorize" ||
    pathname === "/token"
  );
}

async function readForm(req: Request): Promise<Record<string, string>> {
  const ct = req.headers.get("content-type") ?? "";
  if (ct.includes("application/json")) {
    const j = (await req.json().catch(() => ({}))) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(j).map(([k, v]) => [k, typeof v === "string" ? v : ""]));
  }
  const f = await req.formData();
  const out: Record<string, string> = {};
  f.forEach((v, k) => {
    if (typeof v === "string") out[k] = v;
  });
  return out;
}

// ---- handler ---------------------------------------------------------------

type CodePayload = { k: string; c: string; r: string; cid: string; exp: number; jti: string };
type RefreshPayload = { k: string; t: "r"; exp?: number };
/** 同意画面のフォームに入れる印。本人のキーと要求に束ねる。10 分で切れる。 */
type ConsentPayload = { t: "consent"; kh: string; c: string; r: string; exp: number };
/** 認可コードを 1 回しか使えなくする。初めてなら true、使用済みなら false。 */
type ClaimCode = (jti: string) => Promise<boolean>;

const CONSENT_TTL_SEC = 600;
const REFRESH_TTL_SEC = 90 * 24 * 3600;

const esc = (v: string) => v.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

/** 接続の同意画面。cookie だけで承認しない (リンクを踏ませるだけで本人のキーを持ち出せてしまう)。
 *  ボタンを押した POST と、封じた印 (csrf) が揃ったときだけコードを出す。 */
function consentPage(o: { redirectHost: string; params: Record<string, string>; csrf: string }): Response {
  const hidden = Object.entries(o.params)
    .filter(([k]) => ["client_id", "redirect_uri", "response_type", "code_challenge", "code_challenge_method", "state", "resource", "scope"].includes(k))
    .map(([k, v]) => `<input type="hidden" name="${esc(k)}" value="${esc(v)}">`)
    .join("");
  const html = `<!doctype html><html lang="ja"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>こつこつ に接続</title>
<style>body{font-family:-apple-system,BlinkMacSystemFont,"Noto Sans JP",sans-serif;background:#f3f4f6;margin:0;padding:24px;color:#0b0b0d}.card{max-width:440px;margin:40px auto;background:#fff;border:1px solid #ececec;border-radius:14px;padding:28px}h1{font-size:18px;margin:0 0 10px}p{font-size:14px;line-height:1.7;color:#2a2a30}.host{font-family:ui-monospace,monospace;background:#f5f5f6;border-radius:6px;padding:2px 6px}.row{display:flex;gap:10px;margin-top:20px}button{flex:1;padding:12px;border-radius:10px;border:1px solid #e0e0e0;background:#fff;font-size:14px;font-weight:700;cursor:pointer}button.ok{background:#1d3b9e;color:#fff;border-color:#1d3b9e}</style></head>
<body><div class="card"><h1>こつこつ に接続しますか</h1>
<p><span class="host">${esc(o.redirectHost)}</span> のアプリが、あなたの権限で こつこつ のゴール・タスク・コメントを読み書きしようとしています。</p>
<p>自分で接続を始めた覚えが無いときは「やめる」を押してください。</p>
<form method="post">${hidden}<input type="hidden" name="csrf" value="${esc(o.csrf)}">
<div class="row"><button type="submit" name="consent" value="deny">やめる</button><button type="submit" name="consent" value="allow" class="ok">接続する</button></div></form>
</div></body></html>`;
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store", "x-frame-options": "DENY", "content-security-policy": "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'" } });
}

async function keyHash(key: string): Promise<string> {
  return b64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode("kh:" + key)))).slice(0, 24);
}

export async function handleOAuth(
  req: Request,
  secret: string | undefined,
  validate: Validate,
  sessionKey: SessionKey,
  claimCode: ClaimCode = async () => true
): Promise<Response> {
  const url = new URL(req.url);
  const origin = url.origin;
  const p = url.pathname;

  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });

  // RFC 9728: /.well-known/oauth-protected-resource[/<resource path>]
  if (p.startsWith("/.well-known/oauth-protected-resource")) {
    const suffix = p.slice("/.well-known/oauth-protected-resource".length);
    return json({
      resource: origin + (suffix && suffix !== "/" ? suffix : "/mcp"),
      authorization_servers: [issuerOrigin(origin)],
      bearer_methods_supported: ["header"],
      resource_name: "こつこつ",
    });
  }

  // RFC 8414 (+ OIDC 形式で探しに来るクライアント向けにも同じ内容を返す)
  if (p.startsWith("/.well-known/oauth-authorization-server") || p.startsWith("/.well-known/openid-configuration")) {
    const issuer = issuerOrigin(origin);
    return json({
      issuer,
      authorization_endpoint: `${authorizeOrigin(origin)}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      authorization_response_iss_parameter_supported: true,
      response_types_supported: ["code"],
      grant_types_supported: ["authorization_code", "refresh_token"],
      code_challenge_methods_supported: ["S256"],
      token_endpoint_auth_methods_supported: ["none"],
      scopes_supported: ["mcp"],
    });
  }

  if (!secret) return oauthError("server_error", "OAuth is not configured on this server", 500);

  // RFC 7591 動的クライアント登録。
  // 本当の検証は /authorize での redirect_uri 許可リストと、APIキーの照合で行う。
  if (p === "/register") {
    if (req.method !== "POST") return oauthError("invalid_request", "POST required", 405);
    const body = (await req.json().catch(() => null)) as { redirect_uris?: unknown; client_name?: unknown } | null;
    const uris = Array.isArray(body?.redirect_uris) ? (body!.redirect_uris as unknown[]).filter((u): u is string => typeof u === "string") : [];
    if (!uris.length || !uris.every(redirectAllowed)) {
      console.log(`oauth register rejected redirect_uris=${JSON.stringify(uris)}`);
      return oauthError("invalid_redirect_uri", "redirect_uris must be claude.ai / claude.com callbacks or loopback addresses");
    }
    return json(
      {
        // 状態を持たないので、登録された redirect_uris を client_id に封じておく。
        // claude.ai は /authorize で redirect_uri を省くことがあり、その時はここから引く。
        client_id: "kk_" + (await seal(secret, { u: uris })),
        client_id_issued_at: Math.floor(Date.now() / 1000),
        client_name: typeof body?.client_name === "string" ? body.client_name : "Claude",
        redirect_uris: uris,
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      201
    );
  }

  if (p === "/authorize") {
    const params: Record<string, string> =
      req.method === "POST" ? await readForm(req) : Object.fromEntries(url.searchParams.entries());
    const registered = await registeredUris(secret, params.client_id ?? "");
    // 省略時は登録済みの1本を使う。指定があれば登録済みのどれかと一致すること (未登録の client は許可リストだけで見る)。
    const redirectUri = params.redirect_uri || (registered?.length === 1 ? registered[0] : "");
    if (registered && params.redirect_uri && !registered.includes(params.redirect_uri)) {
      console.log(`oauth authorize redirect_uri not registered: ${params.redirect_uri}`);
      return oauthError("invalid_request", "redirect_uri does not match the registered one");
    }
    // redirect_uri が怪しい時はそこへ飛ばさず、この場でエラーを出す
    if (!redirectAllowed(redirectUri)) {
      console.log(`oauth authorize rejected redirect_uri=${redirectUri}`);
      return oauthError("invalid_request", "redirect_uri is not allowed");
    }
    const back = (q: Record<string, string>) => {
      const u = new URL(redirectUri);
      for (const [k, v] of Object.entries(q)) u.searchParams.set(k, v);
      if (params.state) u.searchParams.set("state", params.state);
      u.searchParams.set("iss", issuerOrigin(origin));
      return Response.redirect(u.toString(), 302);
    };
    if (params.response_type !== "code") return back({ error: "unsupported_response_type" });
    if (!params.code_challenge || params.code_challenge_method !== "S256") {
      return back({ error: "invalid_request", error_description: "PKCE (S256) is required" });
    }
    if (req.method !== "GET" && req.method !== "POST") return oauthError("invalid_request", "method not allowed", 405);

    // 1) 接続URL /mcp/<APIキー> の <APIキー> 部分 (claude.ai が resource に付けてきた時)
    const pm = (() => {
      try {
        return new URL(params.resource ?? "").pathname.match(/^\/mcp\/([^/]+)\/?$/);
      } catch {
        return null;
      }
    })();
    let key = pm ? decodeURIComponent(pm[1]).trim() : "";
    if (key && !(await validate(key))) key = "";
    // 2) resource にキーが無い/古い時は、このブラウザで こつこつ にログインしている本人のキー。
    //    claude.ai は resource を /mcp (キー無し) で送ってくることがあり、1) だけだと
    //    黒崎以外のメンバーが繋げなかった (2026-09-24)。
    if (!key) key = (await sessionKey(req)) ?? "";
    if (!key) {
      if (params.login) {
        // ログイン画面から戻ってきたのにまだ未ログイン
        return back({
          error: "access_denied",
          error_description: "こつこつ (kotsukotsu-app.pages.dev) にログインしてから、もう一度接続してください。",
        });
      }
      // 未ログイン → こつこつ のログイン画面へ。ログイン後にこの /authorize へ戻る。
      const again = new URL(url.pathname + url.search, origin);
      again.searchParams.set("login", "1");
      const to = `${origin}/login?next=${encodeURIComponent(again.pathname + again.search)}`;
      return new Response(null, { status: 302, headers: { location: to, "cache-control": "no-store" } });
    }
    // GET = 同意画面を出すだけ。コードは POST (ボタン) でしか出さない
    const kh = await keyHash(key);
    if (req.method === "GET") {
      const csrf = await seal(secret, { t: "consent", kh, c: params.code_challenge, r: redirectUri, exp: Math.floor(Date.now() / 1000) + CONSENT_TTL_SEC } satisfies ConsentPayload);
      return consentPage({ redirectHost: new URL(redirectUri).host || redirectUri, params, csrf });
    }
    if (params.consent !== "allow") return back({ error: "access_denied", error_description: "接続を取りやめました" });
    const consent = await unseal<ConsentPayload>(secret, params.csrf ?? "");
    if (!consent || consent.t !== "consent" || consent.kh !== kh || consent.c !== params.code_challenge || consent.r !== redirectUri || consent.exp < Math.floor(Date.now() / 1000)) {
      return oauthError("invalid_request", "同意の確認が取れませんでした。もう一度接続をやり直してください");
    }
    const code = await seal(secret, {
      k: key,
      c: params.code_challenge,
      r: redirectUri,
      cid: params.client_id ?? "",
      exp: Math.floor(Date.now() / 1000) + CODE_TTL_SEC,
      jti: crypto.randomUUID(),
    } satisfies CodePayload);
    return back({ code });
  }

  if (p === "/token") {
    if (req.method !== "POST") return oauthError("invalid_request", "POST required", 405);
    const f = await readForm(req);
    let key: string;
    if (f.grant_type === "authorization_code") {
      const c = await unseal<CodePayload>(secret, f.code ?? "");
      if (!c || c.exp < Math.floor(Date.now() / 1000)) return oauthError("invalid_grant", "code is invalid or expired");
      if (f.redirect_uri && f.redirect_uri !== c.r) return oauthError("invalid_grant", "redirect_uri mismatch");
      // コードを出した client_id と一致すること (省略で素通りさせない)
      if (c.cid && f.client_id !== c.cid) return oauthError("invalid_grant", "client_id mismatch");
      if (!f.code_verifier || (await s256(f.code_verifier)) !== c.c) return oauthError("invalid_grant", "PKCE verification failed");
      // 同じコードは 1 回だけ (jti の無い古いコードは受けない)
      if (!c.jti || !(await claimCode(c.jti))) return oauthError("invalid_grant", "code already used");
      key = c.k;
    } else if (f.grant_type === "refresh_token") {
      const r = await unseal<RefreshPayload>(secret, f.refresh_token ?? "");
      if (!r || r.t !== "r") return oauthError("invalid_grant", "refresh_token is invalid");
      if (r.exp && r.exp < Math.floor(Date.now() / 1000)) return oauthError("invalid_grant", "refresh_token expired");
      key = r.k;
    } else {
      return oauthError("unsupported_grant_type", "grant_type must be authorization_code or refresh_token");
    }
    // キーがアプリ側で再発行・削除されていたらここで止める
    if (!(await validate(key))) return oauthError("invalid_grant", "API key is no longer valid");
    return json({
      access_token: key,
      token_type: "Bearer",
      refresh_token: await seal(secret, { k: key, t: "r", exp: Math.floor(Date.now() / 1000) + REFRESH_TTL_SEC } satisfies RefreshPayload),
      scope: "mcp",
    });
  }

  return json({ error: "not found" }, 404);
}
