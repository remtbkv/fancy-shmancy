import React from "react";

interface BadgeProps {
  children: React.ReactNode;
  variant?: "primary" | "attention" | "success" | "secondary";
  className?: string;
}

const Badge: React.FC<BadgeProps> = ({
  children,
  variant = "primary",
  className = "",
}) => {
  // Emphasis is the reference's dark pill; `attention` is its red badge. Neither
  // is an accent hue — the app has none.
  const variantClasses = {
    primary: "bg-[var(--fs-ink)] text-[var(--fs-card)]",
    attention: "bg-[var(--fs-badge)] text-[var(--fs-badge-ink)]",
    success: "bg-green-500/20 text-green-400",
    secondary: "bg-mid-gray/20 text-text/70",
  };

  return (
    <span
      className={`inline-flex items-center px-3 py-1 rounded-full text-xs font-medium ${variantClasses[variant]} ${className}`}
    >
      {children}
    </span>
  );
};

export default Badge;
