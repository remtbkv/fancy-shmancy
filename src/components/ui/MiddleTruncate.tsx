import React from "react";

interface MiddleTruncateProps {
  /** The full string; also becomes the hover title. */
  text: string;
  className?: string;
}

/**
 * A path that loses its middle rather than its end.
 *
 * `/Users/you/Library/Application Support/…/recordings` truncated the usual way
 * keeps the part everyone already knows and hides the folder name, which is the
 * only part being chosen. So the last segment is pinned and the leading part
 * absorbs the shrinking.
 *
 * No measurement, no ResizeObserver: the last segment does not shrink at all
 * and the leading part takes every pixel of the overflow. Flex would otherwise
 * distribute the shrink in proportion to each child's width, and the segment
 * losing even one pixel costs it a whole character to the ellipsis. Below the
 * width of the segment itself — the app's minimum window, roughly — the wrapper
 * clips it rather than letting it escape the row.
 */
export const MiddleTruncate: React.FC<MiddleTruncateProps> = ({
  text,
  className = "",
}) => {
  const cut = Math.max(text.lastIndexOf("/"), text.lastIndexOf("\\"));
  const head = cut >= 0 ? text.slice(0, cut + 1) : text;
  const tail = cut >= 0 ? text.slice(cut + 1) : "";

  return (
    <span
      className={`flex min-w-0 items-baseline overflow-hidden ${className}`}
      title={text}
    >
      <span className="min-w-0 truncate">{head}</span>
      {tail && <span className="shrink-0 whitespace-nowrap">{tail}</span>}
    </span>
  );
};
