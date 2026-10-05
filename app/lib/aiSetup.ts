// 連携ガイドの「AI にまとめて入れてもらう」の指示文。Claude Code に貼れば、コネクタ・MCP・プラグインを
// こちらで1つずつ設定しなくても入れてくれる。コマンドは 2026-10-05 に claude mcp add --help /
// claude plugin --help と公式マーケットプレイス (anthropics/claude-plugins-official) で確かめたもの。
// claude.ai のコネクタ (Gmail など) はブラウザでしか足せないので、案内だけにする。
// 当社ホスト版の接続先 URL はここに書かない (公開版の書き出しで止まる)。URL は settings/page.tsx から渡す。

const PLUGINS = ["claude-md-management", "skill-creator", "claude-code-setup"];
const DEV_PLUGINS = ["commit-commands", "code-review"];

export function setupAllPrompt(kotsukotsuUrl: string, official: boolean): string {
  const url = kotsukotsuUrl || "<こつこつの 設定 → APIキー にある接続用URL>";
  return [
    "こつこつで使う AI の道具を、この Claude Code にまとめて入れてください。",
    "",
    "0. 先に私に聞く: Chatwork・Notion・GitHub・Gmail / Google カレンダー / Google ドライブ・Zoom のうち、どれを仕事で使っているか。コードを書くか。答えを元に、入れるものの一覧を見せて OK をもらってから進める",
    "",
    "■ MCP (claude mcp)",
    "1. `claude mcp list` で今の状態を確かめる。既にあるものは入れ直さない",
    `2. こつこつ: \`claude mcp add --transport http --scope user kotsukotsu ${url}\`` + (official ? " (入れたあと /mcp → kotsukotsu → Authenticate でこつこつにログインするよう私に頼む)" : " (この URL にはキーが入っている。ほかのファイル・メモ・コミットに書き残さない)"),
    "3. Notion を使うなら: `claude mcp add --transport http --scope user notion https://mcp.notion.com/mcp` (入れたあと /mcp → notion → Authenticate を私に頼む)",
    "4. Chatwork を使うなら: API トークンを私に聞いて `claude mcp add --scope user chatwork -e CHATWORK_API_TOKEN=<トークン> -- npx -y @chatwork/mcp-server` (トークンは設定以外に書き残さない)",
    "5. GitHub を使うなら: `gh auth status` で確かめ、未ログインなら「ターミナルで gh auth login を実行してください」と私に頼む",
    "",
    "■ claude.ai のコネクタ (Gmail・Google カレンダー・Google ドライブ・Zoom)",
    "6. これはブラウザの claude.ai でしか追加できない。この Claude Code が claude.ai のアカウントでログインしていれば、そこで追加したものはそのまま使える。/mcp に出ていないものだけ、https://claude.ai/customize/connectors を開いて追加するよう私に案内する",
    "",
    "■ プラグイン (claude plugin)",
    "7. `claude plugin marketplace list` に claude-plugins-official が無ければ `claude plugin marketplace add anthropics/claude-plugins-official`",
    `8. ${PLUGINS.map((p) => `\`claude plugin install ${p}@claude-plugins-official\``).join("・")} (メモの整理・決まった作業のスキル化・自動化の提案)`,
    `9. コードを書くなら ${DEV_PLUGINS.map((p) => `\`claude plugin install ${p}@claude-plugins-official\``).join("・")} も`,
    "",
    "最後に、入れたもの / 既にあったもの / 私の操作待ち (ログイン・トークン・ブラウザでの追加) を表で報告し、Claude Code を開き直すよう伝えて止まる。",
  ].join("\n");
}

export function diagnosePrompt(): string {
  return [
    "私の仕事に合わせて、AI に足すとよい道具 (コネクタ・MCP・プラグイン・スキル) を提案してください。まだ何も入れないでください。",
    "",
    "1. こつこつの list_my_tasks で私のタスクを50件まで読む (親のゴール名も見る)。こつこつが繋がっていなければ「こつこつが未接続です。こつこつの 設定 → 連携ガイド を見てください」とだけ返して止まる",
    "2. 今使える道具を確かめる (Claude Code なら /mcp と `claude plugin list`、それ以外は使えるツールの一覧)",
    "3. タスクに出てくるツールや作業 (Chatwork でのやり取り、メール、請求書、議事録、スライド、表計算、コードなど) から、足すと AI が自分で進められるようになる道具を5つまで選ぶ。既にあるものは選ばない",
    "4. 表で見せる: 道具 / できるようになること / 効くタスク (タスク名を2つまで) / 入れ方 (コマンドか画面) / 費用や条件",
    "5. そこで止まる。私が「入れて」と言ったものだけ入れる",
  ].join("\n");
}
