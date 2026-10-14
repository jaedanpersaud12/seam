import { Text } from "@codemirror/state";
import { describe, expect, it } from "vitest";
import { chunkAt, copyChange, mapLine, stepChunk } from "./diffmap";
import type { Chunk } from "./ipc";

const chunk = (kind: Chunk["kind"], left: [number, number], right: [number, number]): Chunk => ({
  kind,
  left,
  right,
  inline: [],
});

// left: a b c d e     right: a X Y c d e f
const chunks = [chunk("replace", [1, 2], [1, 3]), chunk("insert", [5, 5], [6, 7])];

describe("mapLine", () => {
  it("maps equal regions one to one with the running offset", () => {
    expect(mapLine(0, chunks, "left")).toBe(0);
    expect(mapLine(3, chunks, "left")).toBe(4);
    expect(mapLine(4, chunks, "right")).toBe(3);
  });

  it("stretches inside a changed region", () => {
    expect(mapLine(1.5, chunks, "left")).toBe(2);
    expect(mapLine(2, chunks, "right")).toBe(1.5);
  });

  it("continues past the last chunk", () => {
    expect(mapLine(7, chunks, "right")).toBe(5);
    expect(mapLine(9, [], "left")).toBe(9);
  });
});

describe("chunk navigation", () => {
  it("finds the chunk under a line, including insertion points", () => {
    expect(chunkAt(1, chunks, "left")).toBe(0);
    expect(chunkAt(3, chunks, "left")).toBe(-1);
    expect(chunkAt(5, chunks, "left")).toBe(1);
    expect(chunkAt(6, chunks, "right")).toBe(1);
  });

  it("steps forward and back with wrap-around", () => {
    expect(stepChunk(0, chunks, "left", 1)).toBe(0);
    expect(stepChunk(3, chunks, "left", 1)).toBe(1);
    expect(stepChunk(3, chunks, "left", -1)).toBe(0);
    expect(stepChunk(0, chunks, "left", -1)).toBe(1);
    expect(stepChunk(0, chunks, "left", 1, 1)).toBe(0);
    expect(stepChunk(0, [], "left", 1)).toBe(-1);
  });
});

describe("copyChange", () => {
  const apply = (dst: Text, c: { from: number; to: number; insert: string }) =>
    dst.replace(c.from, c.to, Text.of(c.insert.split("\n"))).toString();
  const t = (s: string) => Text.of(s.split("\n"));

  it("replaces a block", () => {
    const src = t("a\nX\nY\nc");
    const dst = t("a\nb\nc");
    expect(apply(dst, copyChange(src, dst, [1, 3], [1, 2]))).toBe("a\nX\nY\nc");
  });

  it("inserts lines in the middle and at the end", () => {
    const src = t("a\nb\nc");
    expect(apply(t("a\nc"), copyChange(src, t("a\nc"), [1, 2], [1, 1]))).toBe("a\nb\nc");
    expect(apply(t("a\nb"), copyChange(src, t("a\nb"), [2, 3], [2, 2]))).toBe("a\nb\nc");
  });

  it("deletes lines in the middle and at the end", () => {
    const src = t("a\nc");
    expect(apply(t("a\nb\nc"), copyChange(src, t("a\nb\nc"), [1, 1], [1, 2]))).toBe("a\nc");
    expect(apply(t("a\nb\nc"), copyChange(t("a\nb"), t("a\nb\nc"), [2, 2], [2, 3]))).toBe("a\nb");
  });
});
