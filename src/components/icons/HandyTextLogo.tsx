import React from "react";

/**
 * "Fancy Shmancy" wordmark — a monocled, top-hatted gentleman of a logo.
 * Keeps the original filename and export so every existing import still works.
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
    <svg
      width={width}
      height={height}
      className={className}
      viewBox="0 0 930 328"
      fill="none"
      xmlns="http://www.w3.org/2000/svg"
    >
      <defs>
        <linearGradient id="fs-gold" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#FBEEB8" />
          <stop offset="0.45" stopColor="#E0BE63" />
          <stop offset="1" stopColor="#A97F2B" />
        </linearGradient>
      </defs>

      {/* top hat, perched at a rakish angle */}
      <g transform="rotate(-14 132 68)">
        <ellipse cx="132" cy="98" rx="82" ry="15" fill="#1C1C24" />
        <path
          d="M88 93 L93 23 Q94 12 105 11 L160 11 Q171 12 172 23 L177 93 Q155 102 132 102 Q109 102 88 93 Z"
          fill="#26262F"
        />
        <path
          d="M86 65 Q132 78 178 65 L179 81 Q132 94 85 81 Z"
          fill="url(#fs-gold)"
        />
      </g>

      {/* the words — a wordmark, the one string that must not be translated */}
      {/* eslint-disable i18next/no-literal-string */}
      <text
        x="238"
        y="176"
        fontFamily="'Snell Roundhand', 'Apple Chancery', cursive"
        fontStyle="italic"
        fontWeight="700"
        fontSize="128"
        fill="url(#fs-gold)"
      >
        Fancy
      </text>
      <text
        x="248"
        y="272"
        fontFamily="Didot, Baskerville, 'Times New Roman', serif"
        fontWeight="600"
        fontSize="56"
        letterSpacing="15"
        fill="url(#fs-gold)"
        opacity="0.9"
      >
        SHMANCY
      </text>
      {/* eslint-enable i18next/no-literal-string */}

      {/* monocle, dangling off the end of the wordmark */}
      <g>
        <circle cx="812" cy="120" r="52" fill="#FFFFFF" fillOpacity="0.07" />
        <circle
          cx="812"
          cy="120"
          r="52"
          fill="none"
          stroke="url(#fs-gold)"
          strokeWidth="13"
        />
        <path
          d="M851 157 Q890 192 880 244"
          fill="none"
          stroke="url(#fs-gold)"
          strokeWidth="8"
          strokeLinecap="round"
          strokeDasharray="14 11"
        />
        <circle cx="878" cy="252" r="9" fill="url(#fs-gold)" />
      </g>
    </svg>
  );
};

export default HandyTextLogo;
