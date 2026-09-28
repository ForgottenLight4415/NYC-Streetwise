/**
 * Something to read while the homepage's hero card fills itself in.
 *
 * A DIFFERENT list from NYC_FACTS on purpose. Those cover a wait the user asked
 * for, after they searched an address, and they are about the city. These cover
 * a wait nobody asked for, on a page where the visitor has not yet decided to
 * search anything — so they are about renting, which is the decision the page is
 * trying to help with. Seeing the same trivia in both places would make the
 * homepage look like it was loading a report it is not loading.
 *
 * Hardcoded for the same reason NYC_FACTS is: a screen whose job is to cover for
 * latency must not introduce a second thing that can be slow.
 *
 * Kept to one line each so a swap never reflows the card.
 */
export const RENTING_FACTS: readonly string[] = [
  "Raising rent by 5% or more requires advance written notice — 30 to 90 days, depending on the tenancy.",
  "Heat season runs October 1 to May 31 — indoor heat is a legal requirement, not a courtesy.",
  "By day during heat season, a building must hold 68°F indoors whenever it is below 55°F outside.",
  "At night during heat season the indoor minimum is 62°F, whatever the weather outside is doing.",
  "Hot water is required year-round at 120°F, day and night, with no seasonal exception.",
  "Broker fees paid by tenants were banned for most listings by the FARE Act in 2025.",
  "A landlord cannot charge more than one month's rent as a security deposit.",
  "Security deposits must be returned within 14 days of moving out, with an itemised list of any deductions.",
  "Roughly two-thirds of New York City households rent rather than own.",
  "About a million apartments citywide are rent-stabilised — ask whether yours is one.",
  "You can ask a landlord for the apartment's rent history if the unit is rent-stabilised.",
  "Application fees are capped at $20, including the cost of any background check.",
  "A tenant has the right to a written lease if they ask for one.",
  "Landlords cannot refuse a tenant for using a housing voucher — that is source-of-income discrimination.",
  "Buildings with three or more apartments must post the managing agent's name and address.",
  "A working smoke alarm and a carbon monoxide alarm are the landlord's responsibility to install.",
  "Window guards are required by law in any apartment where a child under 11 lives.",
  "Lead paint must be disclosed in any building put up before 1960.",
  "A landlord must give 30 to 90 days' notice before ending a tenancy, depending on how long you have lived there.",
  "Late fees are capped at $50 or 5% of the monthly rent, whichever is less.",
  "Withholding rent over unmade repairs is legally risky — a 311 complaint creates a record instead.",
  "Every 311 complaint is public, permanent, and tied to the address, not to the tenant.",
  "An HPD violation stays on a building's record until the landlord certifies the repair.",
  "Class C violations — the hazardous ones — must be fixed within 24 hours.",
  "The city inspects a heat complaint the same day it is filed during heat season.",
  "You can look up any building's open violations on HPD Online before you sign.",
  "Self-help evictions are illegal: only a marshal with a court order can remove a tenant.",
  "A landlord cannot change the locks, cut the utilities, or remove your belongings.",
  "Tenants have the right to organise a tenants' association without retaliation.",
  "Retaliating against a tenant who complained to 311 is illegal for one year after the complaint.",
  "A roommate is allowed under the Roommate Law, even if the lease names only one tenant.",
  "Apartments in buildings with three or more units must be repainted every three years.",
  "Bedbug history for the previous year must be disclosed to every new tenant.",
  "The busiest 311 complaint categories citywide are noise and illegal parking, by a wide margin.",
  "Noise complaints peak in July and August — a quiet block in February may not stay quiet.",
  "Visiting an apartment on a weeknight evening tells you more about the block than a Sunday tour.",
];
