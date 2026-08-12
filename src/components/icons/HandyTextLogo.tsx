import React from "react";
import mark67 from "./mark67.png";

/**
 * The logo: six-seven, held up in a pair of hands. The mark is the whole thing —
 * no wordmark, no monocle. Keeps the original filename and export so every
 * existing import still works; `width` stays the one dimension callers set and
 * the height follows the artwork's own proportions.
 */
const HandyTextLogo = ({
  width,
  height,
  className,
}: {
  width?: number;
  height?: number;
  className?: string;
}) => {
  return (
    <img
      src={mark67}
      width={width}
      height={height}
      className={className}
      alt=""
      draggable={false}
    />
  );
};

export default HandyTextLogo;
