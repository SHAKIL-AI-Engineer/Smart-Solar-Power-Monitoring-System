export type Site = {
  id: string;
  name: string;
  location: string;
  timeZone: string;
  capacityKw: number;
  batteryKwh: number;
};
export type Device = {
  id: string;
  siteId: string;
  name: string;
  type: string;
  protocol: string;
  serial: string;
};
export type Alert = {
  id: number;
  siteId: string;
  deviceId: string;
  severity: string;
  message: string;
  firstSeen: string;
  lastSeen: string;
  resolvedAt: string | null;
  acknowledgedAt: string | null;
};
export type Live = {
  solar: number;
  load: number;
  battery: number;
  grid: number;
  soc: number;
  temperature: number;
  measuredAt: string;
  receivedAt: string;
  quality: string;
  isStale: boolean;
  ageSeconds: number;
  balanceResidualKw: number;
};
export type Overview = {
  site: Site;
  live: Live | null;
  scenario: string;
  devices: Device[];
  alerts: Alert[];
  energy: {
    solarKwh: number;
    demandKwh: number;
    importKwh: number;
    exportKwh: number;
    importedCost: number;
    tariffPerKwh: number;
    method: string;
    periodStart: string;
  };
};
export type Point = {
  measuredAt: string;
  solar: number | null;
  load: number | null;
  battery: number | null;
  grid: number | null;
  soc: number | null;
  samples: number;
};
export type History = { points: Point[]; bucketMinutes: number; range: string };
