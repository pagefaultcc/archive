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
    <div className="rounded-lg border border-white/[0.06] bg-[#08090b] py-2.5 font-mono text-[12px] leading-[19px]">
      {visibleLines.map((line, idx) => {
        const renderedLine = isJSON
          ? highlightJSONLine(line)
          : line.includes("\t")
            ? line.replace(/\t/g, "    ")
            : line;

        return (
          <div
            key={idx}
            className="grid grid-cols-[2.75rem_minmax(0,1fr)] gap-3 px-2.5 hover:bg-white/[0.025] transition-none"
          >
            <span className="select-none text-right text-[#4e535d] tabular-nums text-[11px]">
              {idx + 1}
            </span>
            <span
              className={cn(
                "text-[#d4d8e0]",
                wrapLines ? "break-words whitespace-pre-wrap" : "whitespace-pre",
              )}
            >
              {renderedLine || " "}
            </span>
          </div>
        );
      })}
      {isCapped ? (
        <div className="mt-2 border-t border-white/[0.06] px-3 pt-2 text-center font-sans text-xs text-[#8b909a]">
          Preview capped at 2,500 lines — download file for full contents
        </div>
      ) : null}
    </div>
  );
}

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
        <span className="font-medium text-[#f3f4f6]">{rawKey}</span>
        <span className="text-[#6b707b]">: </span>
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
        <span className="text-[#c8ccd4]">{core}</span>
        {trailingComma ? <span className="text-[#6b707b]">{trailingComma}</span> : null}
      </>
    );
  }
  if (/^-?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(core)) {
    return (
      <>
        <span className="font-semibold text-[#10b981]">{core}</span>
        {trailingComma ? <span className="text-[#6b707b]">{trailingComma}</span> : null}
      </>
    );
  }
  if (["true", "false", "null"].includes(core.toLowerCase())) {
    return (
      <>
        <span className="font-semibold text-[#8b909a]">{core}</span>
        {trailingComma ? <span className="text-[#6b707b]">{trailingComma}</span> : null}
      </>
    );
  }
  return <span className="text-[#c8ccd4]">{val}</span>;
}
