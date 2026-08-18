type IconProps = { className?: string };

const base = "shrink-0";

export function CheckCircleIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={`${base} ${className ?? ""}`} aria-hidden>
      <circle cx="10" cy="10" r="8.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M6.5 10.2 8.7 12.4 13.5 7.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SpinnerIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={`${base} animate-spin ${className ?? ""}`} aria-hidden>
      <circle cx="10" cy="10" r="8.5" stroke="currentColor" strokeWidth="1.5" opacity="0.2" />
      <path d="M18.5 10a8.5 8.5 0 0 0-8.5-8.5" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
    </svg>
  );
}

export function AlertTriangleIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={`${base} ${className ?? ""}`} aria-hidden>
      <path d="M10 3.2 17.5 16.4H2.5L10 3.2Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
      <path d="M10 8.2v3.6" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <circle cx="10" cy="14.1" r="0.9" fill="currentColor" />
    </svg>
  );
}

export function XCircleIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={`${base} ${className ?? ""}`} aria-hidden>
      <circle cx="10" cy="10" r="8.5" stroke="currentColor" strokeWidth="1.5" />
      <path d="M7.3 7.3 12.7 12.7M12.7 7.3 7.3 12.7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function SearchIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={`${base} ${className ?? ""}`} aria-hidden>
      <circle cx="9" cy="9" r="6" stroke="currentColor" strokeWidth="1.6" />
      <path d="M13.5 13.5 17.5 17.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function MapPinIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={`${base} ${className ?? ""}`} aria-hidden>
      <path
        d="M10 17.5S16 12.2 16 8a6 6 0 1 0-12 0c0 4.2 6 9.5 6 9.5Z"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinejoin="round"
      />
      <circle cx="10" cy="8" r="2.2" stroke="currentColor" strokeWidth="1.5" />
    </svg>
  );
}

export function BuildingIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={`${base} ${className ?? ""}`} aria-hidden>
      <rect x="4.5" y="2.5" width="8" height="15" rx="0.6" stroke="currentColor" strokeWidth="1.4" />
      <path d="M12.5 8.5h3v9h-3" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
      <path d="M7 5.5h1.5M7 8.5h1.5M7 11.5h1.5M7 14.5h1.5" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
    </svg>
  );
}

export function BlockIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={`${base} ${className ?? ""}`} aria-hidden>
      <circle cx="10" cy="10" r="8" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10 2v16M2 10h16" stroke="currentColor" strokeWidth="1.2" strokeDasharray="1.6 1.8" />
    </svg>
  );
}

export function ChevronRightIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={`${base} ${className ?? ""}`} aria-hidden>
      <path d="M7.5 4.5 13 10l-5.5 5.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function CloseIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={`${base} ${className ?? ""}`} aria-hidden>
      <path d="M5.5 5.5 14.5 14.5M14.5 5.5 5.5 14.5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
    </svg>
  );
}

export function ClockIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={`${base} ${className ?? ""}`} aria-hidden>
      <circle cx="10" cy="10" r="7.5" stroke="currentColor" strokeWidth="1.4" />
      <path d="M10 6v4.3l3 1.8" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function SunIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={`${base} ${className ?? ""}`} aria-hidden>
      <circle cx="10" cy="10" r="3.6" stroke="currentColor" strokeWidth="1.6" />
      <path
        d="M10 1.6v2.1M10 16.3v2.1M18.4 10h-2.1M3.7 10H1.6M15.94 4.06l-1.49 1.49M5.55 14.45l-1.49 1.49M15.94 15.94l-1.49-1.49M5.55 5.55 4.06 4.06"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function MoonIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={`${base} ${className ?? ""}`} aria-hidden>
      <path
        d="M16.5 12.6A7 7 0 0 1 7.4 3.5a7 7 0 1 0 9.1 9.1Z"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinejoin="round"
      />
    </svg>
  );
}

/** Half-filled disc — the conventional mark for "match the system". */
export function ContrastIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={`${base} ${className ?? ""}`} aria-hidden>
      <circle cx="10" cy="10" r="7.4" stroke="currentColor" strokeWidth="1.6" />
      <path d="M10 2.6a7.4 7.4 0 0 1 0 14.8Z" fill="currentColor" />
    </svg>
  );
}

export function MenuIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={`${base} ${className ?? ""}`} aria-hidden>
      <path d="M3 6h14M3 10h14M3 14h14" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" />
    </svg>
  );
}

export function ArrowRightIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={`${base} ${className ?? ""}`} aria-hidden>
      <path d="M4 10h12M11 5l5 5-5 5" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

export function ScaleIcon({ className }: IconProps) {
  return (
    <svg viewBox="0 0 20 20" fill="none" className={`${base} ${className ?? ""}`} aria-hidden>
      <path d="M10 3v14M5.5 5.5h9" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
      <path d="M4 12.5 6.2 7l2.2 5.5a2.4 2.4 0 0 1-4.4 0ZM11.6 12.5 13.8 7l2.2 5.5a2.4 2.4 0 0 1-4.4 0Z" stroke="currentColor" strokeWidth="1.4" strokeLinejoin="round" />
    </svg>
  );
}
