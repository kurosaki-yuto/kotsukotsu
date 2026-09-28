import test from "node:test";
import assert from "node:assert/strict";
import { resolveMentionedMembers } from "./mentions.ts";

const members = [
  { id: "1", name: "黒崎優斗", email: "kurosaki@example.com" },
  { id: "2", name: "田中", email: "tanaka-short@example.com" },
  { id: "3", name: "田中大二朗", email: "tanaka@example.com" },
];

test("@全員 resolves every assigned member", () => {
  assert.deepEqual(resolveMentionedMembers("@全員 ここに報告してください", members), members);
});

test("a named mention resolves only the longest matching name", () => {
  assert.deepEqual(resolveMentionedMembers("@田中大二朗 進捗をください", members), [members[2]]);
});

test("@全員 plus a named mention does not duplicate a recipient", () => {
  assert.deepEqual(resolveMentionedMembers("@全員 @田中大二朗 確認してください", members), members);
});

test("plain text does not resolve recipients", () => {
  assert.deepEqual(resolveMentionedMembers("全員で確認してください", members), []);
});

test("a space in the registered name does not break the mention", () => {
  const spaced = [{ id: "4", name: "山田　太郎", email: "yamada@example.com" }];
  assert.deepEqual(resolveMentionedMembers("@山田太郎 お願いします", spaced), spaced);
  assert.deepEqual(resolveMentionedMembers("@山田　太郎 お願いします", spaced), spaced);
});

test("a family-name-only mention still notifies (@黒崎 for 黒崎優斗)", () => {
  assert.deepEqual(resolveMentionedMembers("@黒崎 確認お願いします", members), [members[0]]);
});

test("an honorific after the name does not break the mention", () => {
  assert.deepEqual(resolveMentionedMembers("@黒崎優斗さん、確認お願いします", members), [members[0]]);
});

test("an exact short name is not widened to the longer one", () => {
  assert.deepEqual(resolveMentionedMembers("@田中 お願いします", members), [members[1]]);
});

test("a latin name matches case-insensitively", () => {
  const latin = [{ id: "5", name: "Kurosaki", email: "k@example.com" }];
  assert.deepEqual(resolveMentionedMembers("@kurosaki please check", latin), latin);
});

test("an email address in the body is not a mention", () => {
  assert.deepEqual(resolveMentionedMembers("連絡先は tanaka@example.com です", members), []);
});
