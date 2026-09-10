import type { IconDefinition } from "@fortawesome/fontawesome-svg-core";
import {
  faArrowRight,
  faArrowTrendDown,
  faArrowTrendUp,
  faBars,
  faBicycle,
  faBuilding,
  faChevronRight,
  faCircleCheck,
  faCircleHalfStroke,
  faCircleXmark,
  faClock,
  faLocationDot,
  faMagnifyingGlass,
  faMoon,
  faPersonWalking,
  faRoad,
  faScaleBalanced,
  faSpinner,
  faSun,
  faTrainSubway,
  faTree,
  faTriangleExclamation,
  faXmark,
} from "@fortawesome/free-solid-svg-icons";

type IconProps = { className?: string };

const base = "shrink-0";

/**
 * Renders a Font Awesome Free "solid" icon's own path data inside a plain
 * SVG element that this file controls directly - not the
 * `<FontAwesomeIcon icon={...} />` component. That keeps the exact contract
 * every call site already depends on (a `{ className }` prop, sized by
 * whatever height/width utility classes the caller passes in) without
 * pulling in react-fontawesome's runtime CSS injection, and without any of
 * the 17 importing files needing to change.
 */
function FaSvg({
  icon,
  className,
  spin,
}: {
  icon: IconDefinition;
  className?: string;
  spin?: boolean;
}) {
  const [width, height, , , pathData] = icon.icon;
  const paths = Array.isArray(pathData) ? pathData : [pathData];
  return (
    <svg
      viewBox={`0 0 ${width} ${height}`}
      fill="currentColor"
      className={`${base} ${spin ? "animate-spin" : ""} ${className ?? ""}`}
      aria-hidden
    >
      {paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
    </svg>
  );
}

export function CheckCircleIcon({ className }: IconProps) {
  return <FaSvg icon={faCircleCheck} className={className} />;
}

// "Spinner" (fa-spinner) is a static ring of fading blades - the rotation
// that reads as "loading" comes entirely from this `animate-spin`, same as
// the hand-rolled version it replaces.
export function SpinnerIcon({ className }: IconProps) {
  return <FaSvg icon={faSpinner} className={className} spin />;
}

export function AlertTriangleIcon({ className }: IconProps) {
  return <FaSvg icon={faTriangleExclamation} className={className} />;
}

export function XCircleIcon({ className }: IconProps) {
  return <FaSvg icon={faCircleXmark} className={className} />;
}

export function SearchIcon({ className }: IconProps) {
  return <FaSvg icon={faMagnifyingGlass} className={className} />;
}

export function MapPinIcon({ className }: IconProps) {
  return <FaSvg icon={faLocationDot} className={className} />;
}

export function BuildingIcon({ className }: IconProps) {
  return <FaSvg icon={faBuilding} className={className} />;
}

// "Block Quality" - no direct FA equivalent for the abstract concept, so
// this uses "road" (fa-road), the closest concrete match for street/block
// conditions. See categoryIcons.tsx, where this is the blockQuality icon.
export function BlockIcon({ className }: IconProps) {
  return <FaSvg icon={faRoad} className={className} />;
}

export function ChevronRightIcon({ className }: IconProps) {
  return <FaSvg icon={faChevronRight} className={className} />;
}

export function CloseIcon({ className }: IconProps) {
  return <FaSvg icon={faXmark} className={className} />;
}

export function ClockIcon({ className }: IconProps) {
  return <FaSvg icon={faClock} className={className} />;
}

export function SunIcon({ className }: IconProps) {
  return <FaSvg icon={faSun} className={className} />;
}

export function MoonIcon({ className }: IconProps) {
  return <FaSvg icon={faMoon} className={className} />;
}

/** Half-filled disc - the conventional mark for "match the system". */
export function ContrastIcon({ className }: IconProps) {
  return <FaSvg icon={faCircleHalfStroke} className={className} />;
}

export function MenuIcon({ className }: IconProps) {
  return <FaSvg icon={faBars} className={className} />;
}

export function ArrowRightIcon({ className }: IconProps) {
  return <FaSvg icon={faArrowRight} className={className} />;
}

export function TransitIcon({ className }: IconProps) {
  return <FaSvg icon={faTrainSubway} className={className} />;
}

export function ParksIcon({ className }: IconProps) {
  return <FaSvg icon={faTree} className={className} />;
}

export function BikeIcon({ className }: IconProps) {
  return <FaSvg icon={faBicycle} className={className} />;
}

export function WalkIcon({ className }: IconProps) {
  return <FaSvg icon={faPersonWalking} className={className} />;
}

export function ScaleIcon({ className }: IconProps) {
  return <FaSvg icon={faScaleBalanced} className={className} />;
}

export function TrendUpIcon({ className }: IconProps) {
  return <FaSvg icon={faArrowTrendUp} className={className} />;
}

export function TrendDownIcon({ className }: IconProps) {
  return <FaSvg icon={faArrowTrendDown} className={className} />;
}
