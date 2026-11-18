"use client";
import { memo } from "react";
import {
  Area,
  AreaChart,
  CartesianGrid,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  BatteryCharging,
  Building2,
  Cable,
  Check,
  Sun,
  Zap,
} from "lucide-react";
import type { Device, History, Live } from "./types";

const fmt = (n: number) =>
  n.toLocaleString("en-US", { maximumFractionDigits: 1 });
export const PowerChart = memo(function PowerChart({
  history,
  zone,
  batteryOnly = false,
}: {
  history: History;
  zone: string;
  batteryOnly?: boolean;
}) {
  const time = (s: string) =>
    new Date(s).toLocaleTimeString("en-GB", {
      timeZone: zone,
      hour: "2-digit",
      minute: "2-digit",
    });
  return (
    <div
      className="chart"
      role="img"
      aria-label={
        batteryOnly
          ? "Battery state of charge history in percent"
          : "Solar generation and facility demand history in kilowatts"
      }
    >
      <ResponsiveContainer width="100%" height="100%" minWidth={0}>
        <AreaChart
          data={history.points}
          margin={{ top: 10, right: 8, left: -14, bottom: 0 }}
        >
          <defs>
            <linearGradient id="solarFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor="#b6eb60" stopOpacity={0.25} />
              <stop offset="100%" stopColor="#b6eb60" stopOpacity={0} />
            </linearGradient>
          </defs>
          <CartesianGrid
            stroke="#28302f"
            strokeDasharray="3 5"
            vertical={false}
          />
          <XAxis
            dataKey="measuredAt"
            tickFormatter={time}
            minTickGap={48}
            tick={{ fill: "#8d9a98", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <YAxis
            domain={batteryOnly ? [0, 100] : [0, "auto"]}
            tick={{ fill: "#8d9a98", fontSize: 11 }}
            axisLine={false}
            tickLine={false}
          />
          <Tooltip
            labelFormatter={(s) => time(String(s))}
            contentStyle={{
              background: "#1b2523",
              border: "1px solid #3a4943",
              borderRadius: 10,
              fontSize: 12,
            }}
            formatter={(v, name) => [
              `${fmt(Number(v))} ${batteryOnly ? "%" : "kW"}`,
              name,
            ]}
          />
          <Area
            type="monotone"
            name={batteryOnly ? "Battery SOC" : "Solar generation"}
            dataKey={batteryOnly ? "soc" : "solar"}
            stroke="#b6eb60"
            strokeWidth={2.5}
            fill="url(#solarFill)"
            isAnimationActive={false}
          />
          {!batteryOnly && (
            <Line
              type="monotone"
              name="Load demand"
              dataKey="load"
              stroke="#8ca7ff"
              strokeWidth={2}
              dot={false}
              isAnimationActive={false}
            />
          )}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
});

export const EnergyFlow = memo(function EnergyFlow({
  live,
  stale,
}: {
  live: Live;
  stale: boolean;
}) {
  const charging = live.battery < 0;
  const exporting = live.grid < 0;
  return (
    <div className={`energy-flow ${stale ? "stopped" : ""}`}>
      <svg className="flow-lines" viewBox="0 0 420 265" aria-hidden="true">
        <path d="M210 48 V132 M70 132 H350 M210 132 V222" />
        <path
          className="moving"
          d="M210 48 V132"
          style={{ opacity: live.solar > 0 ? 0.7 : 0 }}
        />
        <path
          className="moving"
          d="M70 132 H210"
          style={{
            animationDirection: exporting ? "reverse" : "normal",
            opacity: Math.abs(live.grid) > 0.1 ? 0.7 : 0,
          }}
        />
        <path className="moving" d="M210 132 H350" />
        <path
          className="moving"
          d="M210 132 V222"
          style={{
            animationDirection: charging ? "normal" : "reverse",
            opacity: Math.abs(live.battery) > 0.1 ? 0.7 : 0,
          }}
        />
      </svg>
      <div className="flow-node solar-node">
        <Sun size={22} />
        <span>Solar PV</span>
        <strong>
          {fmt(live.solar)} <small>kW</small>
        </strong>
      </div>
      <div className="flow-node grid-node">
        <Cable size={22} />
        <span>Grid {exporting ? "export" : "import"}</span>
        <strong>
          {fmt(Math.abs(live.grid))} <small>kW</small>
        </strong>
      </div>
      <div className="flow-center">
        <Zap size={27} />
      </div>
      <div className="flow-node load-node">
        <Building2 size={22} />
        <span>Facility load</span>
        <strong>
          {fmt(live.load)} <small>kW</small>
        </strong>
      </div>
      <div className="flow-node battery-node">
        <BatteryCharging size={22} />
        <span>{charging ? "Charging" : "Discharging"}</span>
        <strong>
          {fmt(Math.abs(live.battery))} <small>kW</small>
        </strong>
      </div>
      <div className="balance">
        <Check size={12} /> Balance residual {fmt(live.balanceResidualKw)} kW ·{" "}
        {stale ? "last known values" : "simulated readings"}
      </div>
    </div>
  );
});

export const DeviceTable = memo(function DeviceTable({
  devices,
  live,
  stale,
  offline = false,
  query = "",
}: {
  devices: Device[];
  live: Live;
  stale: boolean;
  offline?: boolean;
  query?: string;
}) {
  const filtered = devices.filter((d) =>
    `${d.name} ${d.type} ${d.serial}`
      .toLowerCase()
      .includes(query.toLowerCase()),
  );
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            <th>Device / source</th>
            <th>Type</th>
            <th>Reading</th>
            <th>Connectivity</th>
            <th>Alarm</th>
          </tr>
        </thead>
        <tbody>
          {filtered.map((d) => {
            const i =
              d.type === "Inverter"
                ? 0
                : d.type === "Battery / PCS"
                  ? 1
                  : d.type === "Grid meter"
                    ? 2
                    : 3;
            return (
              <tr key={d.id}>
                <td>
                  <span className="device-name">
                    <span className={`device-icon icon-${i}`}>
                      {i === 0 ? (
                        <Sun size={16} />
                      ) : i === 1 ? (
                        <BatteryCharging size={16} />
                      ) : i === 2 ? (
                        <Cable size={16} />
                      ) : (
                        <Building2 size={16} />
                      )}
                    </span>
                    <span>
                      <strong>{d.name}</strong>
                      <small>{d.protocol}</small>
                    </span>
                  </span>
                </td>
                <td>{d.type}</td>
                <td className="reading">
                  {fmt(
                    i === 0
                      ? live.solar
                      : i === 1
                        ? live.soc
                        : i === 2
                          ? Math.abs(live.grid)
                          : live.load,
                  )}{" "}
                  <span>{i === 1 ? "% SOC" : "kW"}</span>
                </td>
                <td>
                  <span
                    className={`status ${stale || offline ? "warning" : ""}`}
                  >
                    <i />
                    {offline ? "Offline" : stale ? "Stale" : "Online (sim)"}
                  </span>
                </td>
                <td>
                  <span
                    className={
                      i === 1 && live.temperature > 45 ? "text-amber" : "muted"
                    }
                  >
                    {i === 1 && live.temperature > 45
                      ? "High temperature"
                      : "Normal"}
                  </span>
                </td>
              </tr>
            );
          })}
          {!filtered.length && (
            <tr>
              <td colSpan={5}>No devices match your search.</td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
});
