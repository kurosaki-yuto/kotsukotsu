// claude.ai を指示文入りで開くリンク。
// iPhone では claude.ai/new と claude.ai/code/* が Claude アプリに渡され (claude.ai の
// apple-app-site-association で /new・/code/* を引き受けている)、アプリ側で指示文が落ちることがあった
// (2026-09-29 黒崎「入るときと入らないときがある」)。同じファイルで「#no_universal_links」が付いた
// リンクはアプリに渡さない指定になっているので、末尾に付けてブラウザで開かせる。ブラウザの claude.ai は
// ?q= の指示文を入力欄に入れる (2026-10-05、/new・/code/new とも付けた状態で入ることを確認)。PC でも害は無い。
const STAY_IN_BROWSER = "#no_universal_links";

export function claudeChatUrl(text: string): string {
  return `https://claude.ai/new?q=${encodeURIComponent(text)}${STAY_IN_BROWSER}`;
}

// repoParam は "&repo=owner%2Frepo" の形 (空なら付けない)
export function claudeCodeWebUrl(text: string, repoParam = ""): string {
  return `https://claude.ai/code/new?q=${encodeURIComponent(text)}${repoParam}${STAY_IN_BROWSER}`;
}
