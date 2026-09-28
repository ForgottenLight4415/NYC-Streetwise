import type { CategoryId, CategoryKey } from "./types";

export type CategoryKind = "complaints" | "amenities";

interface CategoryDef {
  key: CategoryKey;
  id: CategoryId;
  kind: CategoryKind;
  label: string;
  description: string;
  /** CSS custom property (sans `var()`), e.g. "--series-building". Each has a
   *  matching "-ink" variant, same convention as the status tokens. */
  colorVar: string;
  /** Legend label for the map ring this category draws, e.g. "Building radius". */
  ringLabel: string;
}

/**
 * The report's six categories, split into two separately-narrowed lists
 * rather than one list filtered by `kind`.
 *
 * `CATEGORIES.filter(c => c.kind === "complaints")` would return the WIDE
 * union of both kinds' shapes, and `report[c.key]` would no longer narrow to
 * a type ScorePanelCard's `panel` prop accepts. Keeping the two lists
 * separate from the start means every consumer that only ever wants one kind
 * — ReportBody's two grids — gets it pre-narrowed.
 */
export const COMPLAINT_CATEGORIES = [
  {
    key: "buildingHealth",
    id: "building",
    kind: "complaints",
    label: "Building Health",
    description: "Complaints tied to this building",
    colorVar: "--series-building",
    ringLabel: "Building radius",
  },
  {
    key: "blockQuality",
    id: "block",
    kind: "complaints",
    label: "Block Quality",
    description: "Complaints on the surrounding block",
    colorVar: "--series-block",
    ringLabel: "Block radius",
  },
] as const satisfies readonly CategoryDef[];

export const AMENITY_CATEGORIES = [
  {
    key: "transitAccess",
    id: "transit",
    kind: "amenities",
    label: "Transit Access",
    description: "Nearest subway, bus, and rail",
    colorVar: "--transit",
    ringLabel: "Transit walkshed",
  },
  {
    key: "parksAccess",
    id: "parks",
    kind: "amenities",
    label: "Parks Access",
    description: "Nearest park, playground, and garden",
    colorVar: "--parks",
    ringLabel: "Parks walkshed",
  },
  {
    key: "bikeAccess",
    id: "bike",
    kind: "amenities",
    label: "Bike Access",
    description: "Nearest Citi Bike dock and bike lane",
    colorVar: "--bike",
    ringLabel: "Bike walkshed",
  },
  {
    key: "walkabilityAccess",
    id: "walkability",
    kind: "amenities",
    label: "Walkability",
    description: "Nearest grocery, restaurant, cafe, and school",
    colorVar: "--walkability",
    ringLabel: "Walkability walkshed",
  },
] as const satisfies readonly CategoryDef[];

export const CATEGORIES = [...COMPLAINT_CATEGORIES, ...AMENITY_CATEGORIES];

/**
 * Short axis labels for the radar, kept separate from each category's own
 * `label` field ("Building Health") because that full name overflows a
 * 260px chart at legible font sizes. A TOTAL record for the same reason
 * CATEGORY_ICONS is one: a category added above without a matching line
 * here is a build error, not a long label wrapping off the chart at
 * runtime. Shared by ReportBody and the compare page's aligned layout, both
 * of which build a radar off the same category list.
 */
export const RADAR_LABEL: Record<CategoryKey, string> = {
  buildingHealth: "Building",
  blockQuality: "Block",
  transitAccess: "Transit",
  parksAccess: "Parks",
  bikeAccess: "Bike",
  walkabilityAccess: "Walk",
};
