/**
 * Monocle glyph — the General tab's icon. Same name/export as the original hand
 * so nothing else needs to change.
 */
const HandyHand = ({
  width,
  height,
}: {
  width?: number | string;
  height?: number | string;
}) => (
  <svg
    width={width || 126}
    height={height || 135}
    viewBox="0 0 126 135"
    className="stroke-text"
    fill="none"
    xmlns="http://www.w3.org/2000/svg"
  >
    <circle cx="58" cy="52" r="40" strokeWidth="9" />
    <path
      d="M88 80 Q112 100 106 126"
      strokeWidth="7"
      strokeLinecap="round"
      strokeDasharray="9 8"
    />
    <circle cx="104" cy="130" r="5" className="fill-text stroke-none" />
  </svg>
);

export default HandyHand;
