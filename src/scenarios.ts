import type { DeviceOptions } from "./types.js";

export interface Scenario {
  id: string;
  name: string;
  description: string;
  devices: DeviceOptions[];
}

export const scenarios: Scenario[] = [
  {
    id: "smart-home",
    name: "Smart Home",
    description: "Living-room climate, study CO₂, and whole-home power telemetry.",
    devices: [
      { type: "climate", id: "living-room", seed: 101, intervalMs: 2_000 },
      { type: "co2", id: "study-air", seed: 102, intervalMs: 3_000 },
      { type: "meter", id: "main-meter", seed: 103, intervalMs: 2_500 },
    ],
  },
  {
    id: "greenhouse",
    name: "Greenhouse",
    description: "Three deterministic climate zones plus an energy meter.",
    devices: [
      { type: "climate", id: "greenhouse-east", seed: 201, intervalMs: 1_500 },
      { type: "climate", id: "greenhouse-west", seed: 202, intervalMs: 1_800 },
      { type: "co2", id: "greenhouse-co2", seed: 203, intervalMs: 2_000 },
      { type: "meter", id: "irrigation-meter", seed: 204, intervalMs: 2_500 },
    ],
  },
  {
    id: "micro-factory",
    name: "Micro Factory",
    description: "Fast telemetry suitable for throughput, alerting, and replay demos.",
    devices: [
      { type: "meter", id: "line-a-meter", seed: 301, intervalMs: 500 },
      { type: "meter", id: "line-b-meter", seed: 302, intervalMs: 700 },
      { type: "climate", id: "cabinet-climate", seed: 303, intervalMs: 1_000 },
      { type: "co2", id: "workshop-air", seed: 304, intervalMs: 1_200 },
    ],
  },
];

export function getScenario(id: string): Scenario | undefined {
  return scenarios.find((scenario) => scenario.id === id);
}
