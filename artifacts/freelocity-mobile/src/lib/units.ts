import conversionRules from "@/src/data/unit-conversions.json";

export type UnitSystem = "imperial" | "metric";

type UnitConfig = {
  label: string;
  name: string;
  abbreviation: string;
  displayDecimals: number;
};

type HistoryLoadRow = {
  loadKg: number;
};

const mass = conversionRules.mass;

export const UNIT_SYSTEMS: Array<{ value: UnitSystem; label: string }> = [
  { value: "imperial", label: mass.units.imperial.label },
  { value: "metric", label: mass.units.metric.label },
];

export function getUnitConfig(system: UnitSystem): UnitConfig {
  return mass.units[system];
}

export function toCanonicalKg(value: number, system: UnitSystem): number {
  return system === "imperial" ? value * mass.kilogramsPerPound : value;
}

export function fromCanonicalKg(valueKg: number, system: UnitSystem): number {
  return system === "imperial" ? valueKg * mass.poundsPerKilogram : valueKg;
}

export function formatMassFromKg(valueKg: number, system: UnitSystem): string {
  const config = getUnitConfig(system);
  return `${fromCanonicalKg(valueKg, system).toFixed(config.displayDecimals)} ${config.abbreviation}`;
}

export function convertHistoryLoads<T extends HistoryLoadRow>(
  rows: T[],
  system: UnitSystem,
): Array<T & { displayLoad: number; displayUnit: string }> {
  const config = getUnitConfig(system);
  return rows.map((row) => ({
    ...row,
    displayLoad: Number(fromCanonicalKg(row.loadKg, system).toFixed(config.displayDecimals)),
    displayUnit: config.abbreviation,
  }));
}