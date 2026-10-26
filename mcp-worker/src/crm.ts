// 自社専用版には顧客台帳が無いので、何も並べない。
import type { Env } from "./env";
import type { McpAuth } from "./lib";

type Tool = { name: string; description: string; inputSchema: Record<string, unknown> };
type ToolResult = { content: { type: "text"; text: string }[]; isError?: boolean };

export async function crmToolsList(_env: Env, _own: Set<string>, _auth: McpAuth): Promise<Tool[]> {
  return [];
}
export async function crmInstructions(_env: Env, _auth: McpAuth): Promise<string> {
  return "";
}
export async function isCrmTool(_env: Env, _name: string): Promise<boolean> {
  return false;
}
export async function callCrmTool(_env: Env, _auth: McpAuth, name: string, _args: Record<string, unknown>): Promise<ToolResult> {
  return { content: [{ type: "text", text: `unknown tool: ${name}` }], isError: true };
}
