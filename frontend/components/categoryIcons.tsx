import type { CategoryKey } from "@/lib/types";
import {
  BikeIcon,
  BlockIcon,
  BuildingIcon,
  ParksIcon,
  TransitIcon,
  WalkIcon,
} from "./icons";

type IconComponent = (props: { className?: string }) => React.ReactElement;

/**
 * A TOTAL record, deliberately: a category added to `lib/categories.ts`
 * without a matching entry here is a build error, not a blank icon slot at
 * runtime.
 */
export const CATEGORY_ICONS: Record<CategoryKey, IconComponent> = {
  buildingHealth: BuildingIcon,
  blockQuality: BlockIcon,
  transitAccess: TransitIcon,
  parksAccess: ParksIcon,
  bikeAccess: BikeIcon,
  walkabilityAccess: WalkIcon,
};
