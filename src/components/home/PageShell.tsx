import React from "react";

interface PageShellProps {
  /** 24px sans page title (`History`, `Models`). Home passes `header` instead. */
  title?: string;
  /** Right-aligned control on the title line, e.g. the History search field. */
  actions?: React.ReactNode;
  /** Replaces the title line outright — the home greeting uses this. */
  header?: React.ReactNode;
  children: React.ReactNode;
}

/**
 * The inside of the main content card: a fixed header band and a natively
 * scrolling body. Page titles are 24px sans (the serif is the settings modal's
 * alone) and sit 24 above the content.
 */
export const PageShell: React.FC<PageShellProps> = ({
  title,
  actions,
  header,
  children,
}) => (
  <div className="flex min-h-0 flex-1 flex-col">
    {(header || title || actions) && (
      <div className="mb-[24px] flex shrink-0 items-center justify-between gap-[16px]">
        {header ?? (
          <h1
            style={{
              fontFamily: "var(--fs-font-sans)",
              fontSize: "var(--fs-text-title)",
              fontWeight: 600,
              color: "var(--fs-ink)",
            }}
          >
            {title}
          </h1>
        )}
        {actions}
      </div>
    )}
    <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
  </div>
);
