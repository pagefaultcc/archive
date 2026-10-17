"use client";

import React, { useMemo } from "react";
import { cn } from "@/lib/utils";

interface CodeViewerProps {
  content: string;
  filename: string;
  wrapLines?: boolean;
}

export function CodeViewer({
  content,
  filename,
  wrapLines = true,
}: CodeViewerProps) {
  const ext = useMemo(() => {
    const dot = filename.lastIndexOf(".");
    return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : "";
  }, [filename]);

  // Clean raw escaped characters (e.g. literal `\r\n` or `\t` text)
  const normalizedContent = useMemo(() => {
    if (!content) return "";
    return content.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
  }, [content]);

  const lines = useMemo(() => {
    if (!normalizedContent) return [];
    return normalizedContent.split("\n");
  }, [normalizedContent]);

  const MAX_PREVIEW_LINES = 2500;
  const isCapped = lines.length > MAX_PREVIEW_LINES;
  const visibleLines = useMemo(
    () => (isCapped ? lines.slice(0, MAX_PREVIEW_LINES) : lines),
    [isCapped, lines],
  );

  const isJSON = ext === "json";

  return (
    <div className="rounded-[6px] border border-[rgba(255,255,255,0.05)] bg-[#08090a] p-3 font-mono text-[12.5px] leading-[20px]">
      {visibleLines.map((line, idx) => {
        const renderedLine = isJSON ? highlightJSONLine(line) : highlightTextLine(line);

        return (
          <div
            key={idx}
            className="grid grid-cols-[2.75rem_minmax(0,1fr)] gap-3 hover:bg-[rgba(255,255,255,0.03)] transition-none"
          >
            <span className="select-none text-right text-[#62666d] tabular-nums text-[11.5px]">
              {idx + 1}
            </span>
            <span
              className={cn(
                "text-[#d0d6e0]",
                wrapLines
                  ? "break-words whitespace-pre-wrap"
                  : "whitespace-pre",
              )}
            >
              {renderedLine || " "}
            </span>
          </div>
        );
      })}
      {isCapped ? (
        <div className="mt-2 border-t border-[rgba(255,255,255,0.05)] pt-2 text-center font-sans text-xs text-[#8a8f98]">
          Preview capped at 2,500 lines — download file for full contents
        </div>
      ) : null}
    </div>
  );
}

// Clean JSON syntax highlighting
function highlightJSONLine(line: string): React.ReactNode {
  const trimmed = line.trimStart();
  const indent = line.slice(0, line.length - trimmed.length);

  const keyValMatch = trimmed.match(/^("([^"]+)")\s*:\s*(.*)$/);
  if (keyValMatch) {
    const rawKey = keyValMatch[1];
    const rest = keyValMatch[3];
    return (
      <>
        <span>{indent}</span>
        <span className="text-[#ffffff] font-medium">{rawKey}</span>
        <span className="text-[#8a8f98]">: </span>
        {formatJSONValue(rest)}
      </>
    );
  }

  return (
    <>
      <span>{indent}</span>
      {formatJSONValue(trimmed)}
    </>
  );
}

function formatJSONValue(val: string): React.ReactNode {
  const trimmed = val.trim();
  const trailingComma = trimmed.endsWith(",") ? "," : "";
  const core = trimmed.endsWith(",") ? trimmed.slice(0, -1).trim() : trimmed;

  if (core.startsWith('"') && core.endsWith('"')) {
    return (
      <>
        <span className="text-[#d0d6e0]">{core}</span>
        {trailingComma ? <span className="text-[#8a8f98]">{trailingComma}</span> : null}
      </>
    );
  }
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(core)) {
    return (
      <>
        <span className="text-[#8a8f98] font-semibold">{core}</span>
        {trailingComma ? <span className="text-[#8a8f98]">{trailingComma}</span> : null}
      </>
    );
  }
  if (["true", "false", "null"].includes(core.toLowerCase())) {
    return (
      <>
        <span className="text-[#8a8f98] font-semibold">{core}</span>
        {trailingComma ? <span className="text-[#8a8f98]">{trailingComma}</span> : null}
      </>
    );
  }
  return <span className="text-[#d0d6e0]">{val}</span>;
}

// Clean text line highlighting:
// Replaces literal tabs with genuine visual indentation spaces.
// NEVER prints literal "\t", "\n", or "\r".
function highlightTextLine(line: string): React.ReactNode {
  // If line contains tabs, expand them to 4 clean spaces
  if (line.includes("\t")) {
    const expanded = line.replace(/\t/g, "    ");
    return <span className="text-[#d0d6e0]">{expanded}</span>;
  }
  return <span className="text-[#d0d6e0]">{line}</span>;
}
