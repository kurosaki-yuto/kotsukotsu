// 設定 > 連携ガイド (app/settings/IntegrationGuide.tsx) に出す中身。
// こつこつ本体は他のツールと繋ぐ機能を持たない。ここにあるのは「AI の側に何を繋ぐとよいか」と、
// その繋ぎ方を AI に頼む指示文だけ。
//
// 繋ぎ方は 2026-10-05 に各社の公式ページで確かめた (出典は docs)。確かめられなかったものは「未確認」と書く。
// 推測で手順を書くと、押した人の AI がそのとおりに間違ったコマンドを打つので、分からないところは書かない。
// 当社ホスト版の接続先 URL はここに書かない (公開版の書き出しで止まる)。URL は settings/page.tsx から渡す。

export type SetupApp = "claudeCode" | "codex";

export type Connector = {
  name: string;
  provider: string;
  reads: string; // AI が読めるようになるもの。こつこつの現状のどこに効くか
  claude: string; // Claude (デスクトップ・Web) での繋ぎ方
  claudeCode: string;
  codex: string;
  note?: string; // プランや権限の条件
  docs?: string; // 公式の手順
  claudeConnector?: boolean; // claude.ai の コネクタ に公式のものがある
  setup?: SetupApp[]; // 指示文を渡して AI に繋がせられるアプリ
  steps?: { claudeCode?: string[]; codex?: string[] }; // 指示文に入れる公式の手順
};

export const CONNECTOR_GROUPS: { title: string; items: Connector[] }[] = [
  {
    title: "連絡ツール — 先方の最後の発言とボールが分かる",
    items: [
      {
        name: "Chatwork",
        provider: "Chatwork 公式 MCP (@chatwork/mcp-server)",
        reads: "部屋ごとの最新メッセージとタスク。現状の「ボール (次に動くのは誰か)」と「何待ちか」の材料になります。",
        claude: "コネクタ一覧にはありません。Claude Code・Codex に登録して使います。",
        claudeCode: "API トークンを入れて登録します (下のボタンで AI に頼めます)。",
        codex: "~/.codex/config.toml に登録します (下のボタンで AI に頼めます)。",
        note: "API トークンは Chatwork の「サービス連携 > API Token」で発行します。パーソナルプラン以外は組織管理者の承認が要ります。Node.js が要ります。",
        docs: "https://github.com/chatwork/chatwork-mcp-server",
        setup: ["claudeCode", "codex"],
        steps: {
          claudeCode: [
            "Chatwork の API トークンを私に聞く",
            "`claude mcp add --scope user chatwork -e CHATWORK_API_TOKEN=<トークン> -- npx -y @chatwork/mcp-server` を実行する",
          ],
          codex: [
            "Chatwork の API トークンを私に聞く",
            "~/.codex/config.toml の末尾に次を足す:\n[mcp_servers.chatwork]\ncommand = \"npx\"\nargs = [\"-y\", \"@chatwork/mcp-server\"]\n\n[mcp_servers.chatwork.env]\nCHATWORK_API_TOKEN = \"<トークン>\"",
          ],
        },
      },
      {
        name: "Gmail",
        provider: "Google 提供 (Anthropic 確認済みのコネクタ)",
        reads: "先方からのメールと、こちらが送ったメール。依頼・期限・「いつ誰に投げたか」の材料になります。",
        claude: "カスタマイズ > コネクタ から Gmail を追加します。全プランで使えます。",
        claudeCode: "Claude に追加したコネクタは、同じアカウントでログインした Claude Code でもそのまま使えます (/mcp で確認)。",
        codex: "Codex の Gmail プラグインを入れます (ChatGPT デスクトップの Plugins、CLI は /plugins)。",
        docs: "https://support.claude.com/en/articles/10166901-use-google-workspace-connectors",
        claudeConnector: true,
      },
    ],
  },
  {
    title: "予定と資料 — 次の打ち合わせと手元の資料が分かる",
    items: [
      {
        name: "Google カレンダー",
        provider: "Google 提供 (Anthropic 確認済みのコネクタ)",
        reads: "商談・定例の日時。現状の「次にいつ動くか」と、期限の材料になります。",
        claude: "カスタマイズ > コネクタ から Google Calendar を追加します。全プランで使えます。",
        claudeCode: "Claude に追加したコネクタをそのまま使えます。",
        codex: "未確認 (Codex 用の公式プラグインは確認できていません)。",
        note: "予定の作成・変更もできるので、AI に変えてよいか聞かせる運用にしてください。",
        docs: "https://support.claude.com/en/articles/10166901-use-google-workspace-connectors",
        claudeConnector: true,
      },
      {
        name: "Google ドライブ",
        provider: "Google 提供 (Anthropic 確認済みのコネクタ)",
        reads: "提案書・見積・議事録などの資料。タスクの「リソース」に貼るリンクの元になります。",
        claude: "カスタマイズ > コネクタ から Google Drive を追加します。全プランで使えます。",
        claudeCode: "Claude に追加したコネクタをそのまま使えます。",
        codex: "Codex の Google Drive プラグインを入れます (ドキュメント・スプレッドシート・スライドも読めます)。",
        docs: "https://support.claude.com/en/articles/10166901-use-google-workspace-connectors",
        claudeConnector: true,
      },
      {
        name: "Google スプレッドシート",
        provider: "Google 提供 (Anthropic のコネクタ)",
        reads: "売上表・顧客リスト・進捗表などの表。数字のある完了の基準 (◯件・◯円) の今の値を読めます。",
        claude: "カスタマイズ > コネクタ で Google Drive に加えて Google Sheets を有効にします。ドライブで探し、スプレッドシートの中身を読み書きします (Claude の Web・デスクトップ。チャット横での編集はベータ)。",
        claudeCode: "Claude に追加したコネクタをそのまま使えます。",
        codex: "Codex の Google Drive プラグインで、スプレッドシートも読めます。",
        docs: "https://support.claude.com/en/articles/10166901-use-google-workspace-connectors",
        claudeConnector: true,
      },
      {
        name: "Notion",
        provider: "Notion 公式 MCP",
        reads: "社内 wiki・案件ページ・議事録。決まったことや経緯の材料になります。",
        claude: "カスタマイズ > コネクタ から Notion を追加し、Notion でログインします。",
        claudeCode: "`claude mcp add --transport http notion https://mcp.notion.com/mcp` → /mcp で認証します。",
        codex: "config.toml に url を書き、`codex mcp login notion` で認証します。",
        docs: "https://developers.notion.com/docs/get-started-with-mcp",
        claudeConnector: true,
        setup: ["claudeCode", "codex"],
        steps: {
          claudeCode: [
            "`claude mcp add --transport http --scope user notion https://mcp.notion.com/mcp` を実行する",
            "私に「Claude Code を開き直して /mcp → notion → Authenticate で Notion にログインしてください」と伝える",
          ],
          codex: [
            "~/.codex/config.toml の末尾に次を足す:\n[mcp_servers.notion]\nurl = \"https://mcp.notion.com/mcp\"",
            "`codex mcp login notion` を実行し、ブラウザで Notion の許可を私に頼む",
          ],
        },
      },
    ],
  },
  {
    title: "開発 — どのコミットで何を直したかが分かる",
    items: [
      {
        name: "GitHub",
        provider: "GitHub 公式 (gh コマンド / GitHub MCP)",
        reads: "コミット・プルリクエスト・issue。開発タスクの「済んだこと」(どのコミットで直したか) の材料になります。",
        claude: "チャットやプロジェクトに GitHub のリポジトリを追加できます (非公開リポジトリは GitHub 側で Claude のアプリに許可を出します)。",
        claudeCode: "手元の gh コマンドに GitHub でログインしておけば、そのまま読めます。MCP で繋ぐなら公式の GitHub MCP を使います。",
        codex: "gh コマンドで同じように読めます。MCP なら `codex mcp add github --url https://api.githubcopilot.com/mcp/ --bearer-token-env-var GITHUB_PAT_TOKEN`。",
        note: "MCP で繋ぐ場合は GitHub の個人アクセストークンが要ります。",
        docs: "https://github.com/github/github-mcp-server",
        setup: ["claudeCode", "codex"],
        steps: {
          claudeCode: [
            "`gh auth status` で GitHub にログイン済みか確かめる。gh が無ければ入れ方を私に案内して止まる",
            "ログインしていなければ、私に「ターミナルで gh auth login を実行してブラウザで許可してください」と頼んで止まる",
          ],
          codex: [
            "`gh auth status` で GitHub にログイン済みか確かめる。gh が無ければ入れ方を私に案内して止まる",
            "ログインしていなければ、私に「ターミナルで gh auth login を実行してブラウザで許可してください」と頼んで止まる",
          ],
        },
      },
    ],
  },
  {
    title: "議事録 — 商談で決まったことが分かる",
    items: [
      {
        name: "Zoom",
        provider: "Zoom 公式 (Zoom for Claude)",
        reads: "会議の要約と文字起こし。商談で約束したことを、完了の基準やタスクに落とす材料になります。",
        claude: "カスタマイズ > コネクタ から Zoom for Claude を追加し、Zoom でログインします。",
        claudeCode: "Claude に追加したコネクタをそのまま使えます (専用のコマンドは未確認)。",
        codex: "Zoom 公式の Codex プラグインがあります (入れ方の手順は未確認)。",
        note: "Zoom の有料ライセンスが要ります。",
        docs: "https://developers.zoom.us/docs/mcp/servers/",
        claudeConnector: true,
      },
    ],
  },
];

// こつこつの「現状」の項目ごとに、AI がどこから材料を取るか。
// 現状の書き方 (日付 / 済んだこと / ボール / 残り・詰まり) は MCP の指示文 (mcp-worker) と同じ。
export const STATE_SOURCES: { item: string; from: string }[] = [
  { item: "済んだこと", from: "こつこつの完了タスクとコメント。フォルダの資料と GitHub のコミット。Google ドライブ・スプレッドシート・Notion。" },
  { item: "ボール", from: "Chatwork・Gmail の最後の発言。先方の最後の発言がこちらへの質問なら、ボールはこちら。" },
  { item: "残り・詰まり", from: "送ったメールやチャットの日時 (いつ誰に投げたか)。Google カレンダーの次の予定。" },
  { item: "決まったこと", from: "Zoom の議事録。約束したことは完了の基準とタスクに落とします。" },
  { item: "見られなかったもの", from: "繋いでいない連絡手段は、AI が現状に「LINE未確認」のように書きます。見たことにはしません。" },
];

const CHECK_TARGETS = "こつこつ / Chatwork / Gmail / Google カレンダー / Google ドライブ / Google スプレッドシート / Notion / GitHub (gh コマンドも可) / Zoom";

export function checkPrompt(): string {
  return [
    "今あなたに繋がっている外部ツールを確かめて、次の表で返してください。",
    "ツールは呼ばずに、使えるツールの一覧だけで判断してください。",
    "",
    "| 連携先 | 繋がっているか | 使えるツール名の例 |",
    `対象: ${CHECK_TARGETS}`,
    "",
    "繋がっていないものがあれば、「こつこつの 設定 → 連携ガイド に繋ぎ方があります」とだけ伝えて止まってください。",
  ].join("\n");
}

const APP_LABEL: Record<SetupApp, string> = { claudeCode: "Claude Code", codex: "Codex" };

// 連携先を AI に繋がせる指示文。Claude Code / Codex のどちらで開いても読めるよう、両方の手順を入れる
export function connectorPrompt(c: Connector): string {
  const lines = [
    `${c.name} を、あなた (この AI) から読めるように繋いでください。`,
    `目的: こつこつのゴールの現状を書くときに、${c.name} の中身を読めるようにするため。`,
    c.docs ? `公式の手順: ${c.docs}` : "",
    "",
  ];
  for (const app of c.setup ?? []) {
    const steps = c.steps?.[app];
    if (!steps?.length) continue;
    lines.push(`■ あなたが ${APP_LABEL[app]} の場合`);
    steps.forEach((s, i) => lines.push(`${i + 1}. ${s}`));
    lines.push("");
  }
  if (!c.setup?.length) {
    lines.push(`■ Claude の場合: ${c.claude}`);
    lines.push(`■ Codex の場合: ${c.codex}`);
    lines.push("画面での操作が要るので、私に手順を案内して止まってください。");
    lines.push("");
  }
  lines.push(
    "守ること:",
    "- 既に繋がっていれば何も変えずに「繋がっています」と返す",
    "- ログインや画面での許可が要るところは私に頼んで止まる。トークンは私に聞き、設定以外 (ファイル・メモ・コミット) に書き残さない",
    "- 繋いだツールがこの会話で使えないときは、アプリを開き直すよう私に伝えて止まる",
    "- 使えるときは、読み取りのツールを1回だけ呼んで (送信・書き込みはしない) 読めたことを報告して止まる",
  );
  return lines.filter((l, i, a) => !(l === "" && a[i - 1] === "")).join("\n");
}

// こつこつ自体を Claude Code に繋ぐ指示文。official = 当社ホスト版 (共通 URL + ブラウザでログイン)
export function claudeCodeSetupPrompt(url: string, official: boolean): string {
  const target = url || "<こつこつの 設定 → APIキー にある接続用URL>";
  return [
    "こつこつ (ゴールとタスクの管理ツール) を、この Claude Code に MCP で繋いでください。",
    "1. `claude mcp list` で kotsukotsu が既にあるか確かめる。あれば何も変えずに「設定済みです」と返して止まる",
    `2. \`claude mcp add --transport http --scope user kotsukotsu ${target}\` を実行する`,
    official
      ? "3. 私に「Claude Code を開き直して /mcp → kotsukotsu → Authenticate を選び、ブラウザでこつこつにログインしてください」と伝えて止まる"
      : "3. 私に「Claude Code を開き直すと こつこつ のツールが使えます」と伝えて止まる。この URL にはキーが入っているので、ほかのファイル・メモ・コミットに書き残さない",
  ].join("\n");
}

// こつこつ自体を Codex に繋ぐ指示文。Codex はキー入りURLを url に直接書く (ログイン画面を出さずに繋がる)
export function codexSetupPrompt(keyUrl: string): string {
  const target = keyUrl || "<こつこつの 設定 → APIキー にある、あなた専用のキー入りURL>";
  return [
    "こつこつ (ゴールとタスクの管理ツール) を、この Codex に MCP で繋いでください。",
    "1. ~/.codex/config.toml に [mcp_servers.kotsukotsu] が既にあるか確かめる。あれば何も変えずに「設定済みです」と返して止まる",
    "2. 無ければ末尾に次の2行を足す。この URL にはキーが入っているので、ほかのファイル・メモ・コミットに書き残さない",
    "[mcp_servers.kotsukotsu]",
    `url = "${target}"`,
    "3. 私に「Codex を開き直すと こつこつ のツールが使えます」と伝えて止まる",
  ].join("\n");
}
