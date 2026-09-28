// Outliner markdown ⇔ tree conversion.
// Format: 2-space indent, each line `- <text>`. Empty lines ignored on parse.

export type Node = {
  id: string;
  text: string;
  children: Node[];
};

const INDENT = "  ";

let idCounter = 0;
const newId = () => `n${Date.now().toString(36)}_${(idCounter++).toString(36)}`;

export function parseMd(md: string): Node[] {
  const lines = md.split(/\r?\n/);
  const root: Node[] = [];
  const stack: { depth: number; node: Node }[] = [];

  for (const raw of lines) {
    if (!raw.trim()) continue;
    const m = raw.match(/^(\s*)-\s?(.*)$/);
    if (!m) continue;
    const depth = Math.floor(m[1].length / 2);
    const text = m[2];
    const node: Node = { id: newId(), text, children: [] };

    while (stack.length && stack[stack.length - 1].depth >= depth) stack.pop();
    if (stack.length === 0) {
      root.push(node);
    } else {
      stack[stack.length - 1].node.children.push(node);
    }
    stack.push({ depth, node });
  }
  return root;
}

export function formatMd(nodes: Node[]): string {
  const out: string[] = [];
  const walk = (list: Node[], depth: number) => {
    for (const n of list) {
      out.push(`${INDENT.repeat(depth)}- ${n.text}`);
      if (n.children.length) walk(n.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return out.length ? out.join("\n") + "\n" : "";
}

// Ensure every node has a fresh id (used after server roundtrip).
export function withIds(nodes: Node[]): Node[] {
  return nodes.map((n) => ({ ...n, id: newId(), children: withIds(n.children) }));
}

export function countLeaves(nodes: Node[]): number {
  let c = 0;
  const walk = (l: Node[]) => l.forEach((n) => { c++; if (n.children.length) walk(n.children); });
  walk(nodes);
  return c;
}
