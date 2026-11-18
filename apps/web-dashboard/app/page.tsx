"use client";
import { useEffect, useRef, useState } from "react";
import { HubConnectionBuilder, LogLevel } from "@microsoft/signalr";
import {
  Activity,
  ArrowDownLeft,
  ArrowRight,
  ArrowUpRight,
  BatteryCharging,
  Bell,
  Building2,
  Cable,
  ChartNoAxesCombined,
  CheckCheck,
  ChevronDown,
  CircleHelp,
  Download,
  FlaskConical,
  LayoutDashboard,
  Leaf,
  LoaderCircle,
  LogOut,
  Menu,
  Radio,
  RefreshCw,
  Search,
  ShieldCheck,
  Sun,
  X,
  Zap,
} from "lucide-react";
import { DeviceTable, EnergyFlow, PowerChart } from "./components";
import type { Alert, History, Overview, Site } from "./types";

type View =
  "Overview" | "Generation" | "Battery" | "Analytics" | "Devices" | "Alerts";
const navigation = [
  { label: "Overview", icon: LayoutDashboard },
  { label: "Generation", icon: Sun },
  { label: "Battery", icon: BatteryCharging },
  { label: "Analytics", icon: ChartNoAxesCombined },
  { label: "Devices", icon: Cable },
  { label: "Alerts", icon: Bell },
] as const;
const number = (n: number) =>
  n.toLocaleString("en-US", { maximumFractionDigits: 1 });
async function api<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...options,
    headers: { "Content-Type": "application/json", ...options?.headers },
  });
  if (!response.ok) {
    const problem = await response.json().catch(() => ({}));
    throw new Error(
      response.status === 401
        ? "Your session expired. Please sign in again."
        : problem.detail || `Request failed (${response.status}).`,
    );
  }
  return response.status === 204 ? (undefined as T) : response.json();
}

export default function Dashboard() {
  const [session, setSession] = useState<"loading" | "guest" | "viewer">(
    "loading",
  );
  const [sites, setSites] = useState<Site[]>([]);
  const [siteId, setSiteId] = useState("factory-01");
  const [view, setView] = useState<View>("Overview");
  const [range, setRange] = useState("24h");
  const [data, setData] = useState<Overview | null>(null);
  const [history, setHistory] = useState<History | null>(null);
  const [alerts, setAlerts] = useState<Alert[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now());
  const [tick, setTick] = useState(0);
  const [connection, setConnection] = useState("Connecting");
  const [query, setQuery] = useState("");
  const [mobileMenu, setMobileMenu] = useState(false);
  const [help, setHelp] = useState(false);
  const [showSimulator, setShowSimulator] = useState(false);
  const [notice, setNotice] = useState("");
  const dialogRef = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (help) dialogRef.current?.showModal();
  }, [help]);
  const refresh = useRef<() => void>(() => {});
  refresh.current = () => setTick((t) => t + 1);

  useEffect(() => {
    fetch("/api/auth/me")
      .then((r) => setSession(r.ok ? "viewer" : "guest"))
      .catch(() => setSession("guest"));
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(clock);
  }, []);
  useEffect(() => {
    if (session !== "viewer") return;
    const controller = new AbortController();
    api<Site[]>("/api/v1/sites", { signal: controller.signal })
      .then(setSites)
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => controller.abort();
  }, [session]);
  useEffect(() => {
    if (session !== "viewer") return;
    const controller = new AbortController();
    const url = `/api/v1/sites/${siteId}`;
    Promise.all([
      api<Overview>(`${url}/overview`, { signal: controller.signal }),
      api<History>(`${url}/telemetry?range=${range}`, {
        signal: controller.signal,
      }),
      api<Alert[]>(`/api/v1/alerts?siteId=${siteId}`, {
        signal: controller.signal,
      }),
    ])
      .then(([overview, series, a]) => {
        setData(overview);
        setHistory(series);
        setAlerts(a);
        setError("");
      })
      .catch((e) => {
        if (e.name !== "AbortError") setError(e.message);
      });
    return () => controller.abort();
  }, [session, siteId, range, tick]);
  useEffect(() => {
    if (session !== "viewer") return;
    let disposed = false;
    const hub = new HubConnectionBuilder()
      .withUrl("/hubs/telemetry")
      .withAutomaticReconnect()
      .configureLogging(LogLevel.Error)
      .build();
    hub.on("telemetry", () => refresh.current());
    hub.onreconnecting(() => setConnection("Reconnecting"));
    hub.onreconnected(async () => {
      await hub.invoke("Subscribe", siteId);
      if (!disposed) {
        setConnection("Connected");
        refresh.current();
      }
    });
    hub.onclose(() => {
      if (!disposed) setConnection("Polling fallback");
    });
    hub
      .start()
      .then(async () => {
        if (!disposed) {
          await hub.invoke("Subscribe", siteId);
          setConnection("Connected");
        }
      })
      .catch(() => {
        if (!disposed) setConnection("Polling fallback");
      });
    const timer = setInterval(() => refresh.current(), 10000);
    return () => {
      disposed = true;
      clearInterval(timer);
      void hub.stop();
    };
  }, [session, siteId]);

  async function login() {
    setBusy(true);
    setError("");
    try {
      await api("/api/auth/demo", { method: "POST" });
      setSession("viewer");
    } catch (e) {
      setError(
        e instanceof Error
          ? e.message
          : "Sign-in failed. Check the API service.",
      );
    } finally {
      setBusy(false);
    }
  }
  async function changeScenario(scenario: string) {
    setBusy(true);
    try {
      await api(`/api/v1/sites/${siteId}/simulation`, {
        method: "POST",
        body: JSON.stringify({ scenario }),
      });
      setNotice("Scenario saved. Measurements update within 5 seconds.");
      refresh.current();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function acknowledge(id: number) {
    setBusy(true);
    try {
      await api(`/api/v1/alerts/${id}/acknowledge`, { method: "POST" });
      refresh.current();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  function selectSite(id: string) {
    setSiteId(id);
    setData(null);
    setHistory(null);
    setAlerts([]);
    setNotice("");
  }
  function navigate(next: View) {
    setView(next);
    setMobileMenu(false);
    setQuery("");
  }

  if (session === "loading")
    return (
      <main className="loading-screen">
        <Sun size={42} />
        <p>Opening SolarOps…</p>
      </main>
    );
  if (session === "guest")
    return (
      <main className="login-page">
        <div className="login-orbit" aria-hidden="true" />
        <div className="login-content">
          <div className="brand">
            <span className="brand-icon">
              <Sun size={26} />
            </span>
            SolarOps<span className="brand-dot">®</span>
          </div>
          <span className="eyebrow">ENERGY INTELLIGENCE, EVERYWHERE</span>
          <h1>
            A clearer view.
            <br />A brighter future.
          </h1>
          <p>
            Your generation, storage, and demand.
            <br />
            One connected energy workspace.
          </p>
          <div className="login-card">
            <div className="badge">
              <FlaskConical size={13} /> INTERACTIVE DEMO
            </div>
            <h2>Explore your energy.</h2>
            <p>
              Two simulated sites. Real data flow.
              <br />
              No hardware or account setup needed.
            </p>
            <button className="primary" onClick={login} disabled={busy}>
              {busy ? (
                <LoaderCircle size={17} className="spin" />
              ) : (
                <>
                  Open demo workspace <ArrowRight size={17} />
                </>
              )}
            </button>
            {error && (
              <p className="text-amber" role="alert">
                {error}
              </p>
            )}
            <small>
              <ShieldCheck size={14} /> Read-only monitoring · Equipment control
              disabled
            </small>
          </div>
          <footer>SMART SOLAR POWER MONITORING & ENERGY OPTIMIZATION</footer>
        </div>
      </main>
    );

  const live = data?.live;
  const age = live
    ? Math.max(0, (now - Date.parse(live.measuredAt)) / 1000)
    : Infinity;
  const stale = !live || age > 15 || !!error;
  const zone = data?.site.timeZone ?? "Asia/Dhaka";
  const date = new Date(now).toLocaleDateString("en-GB", {
    timeZone: zone,
    day: "2-digit",
    month: "short",
    year: "numeric",
  });
  const activeAlerts = alerts.filter((a) => !a.resolvedAt);
  const timestamp = (s: string) =>
    new Date(
      s.endsWith("Z") || /[+-]\d\d:\d\d$/.test(s) ? s : `${s}Z`,
    ).toLocaleString("en-GB", {
      timeZone: zone,
      day: "2-digit",
      month: "short",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  return (
    <div className="app-shell">
      {mobileMenu && (
        <button
          className="sidebar-backdrop"
          aria-label="Close navigation"
          onClick={() => setMobileMenu(false)}
        />
      )}
      <aside className={`sidebar ${mobileMenu ? "open" : ""}`}>
        <a className="brand" href="/" aria-label="SolarOps home">
          <span className="brand-icon">
            <Sun size={24} />
          </span>
          SolarOps<span className="brand-dot">®</span>
        </a>
        <div className="workspace-label">
          WORKSPACE <span>DEMO</span>
        </div>
        <div className="workspace">
          <span className="workspace-avatar">S</span>
          <span>
            <strong>Solar energy platform</strong>
            <small>Demo portfolio · 2 sites</small>
          </span>
        </div>
        <div className="nav-caption">MONITOR</div>
        <nav aria-label="Main navigation">
          {navigation.map(({ label, icon: Icon }) => (
            <button
              key={label}
              className={view === label ? "active" : ""}
              onClick={() => navigate(label)}
            >
              <Icon size={18} />
              {label}
              {label === "Alerts" && activeAlerts.length > 0 && (
                <span className="nav-count">{activeAlerts.length}</span>
              )}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="edge-card">
            <span>
              <ShieldCheck size={17} /> Read-only workspace
            </span>
            <p>
              Monitoring simulated equipment.
              <br />
              No physical controls connected.
            </p>
            <div>
              <i /> SIMULATOR AVAILABLE
            </div>
          </div>
          <button className="help-button" onClick={() => setHelp(true)}>
            <CircleHelp size={17} /> Workspace guide <ArrowUpRight size={15} />
          </button>
          <div className="profile">
            <span className="avatar">DO</span>
            <span>
              <strong>Demo operator</strong>
              <small>Viewer access</small>
            </span>
            <button
              aria-label="Sign out"
              onClick={async () => {
                try {
                  await api("/api/auth/logout", { method: "POST" });
                  setSession("guest");
                  setData(null);
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
            >
              <LogOut size={16} />
            </button>
          </div>
        </div>
      </aside>
      <div className="main-shell">
        <header className="topbar">
          <div className="breadcrumbs">
            <button
              className="mobile-toggle"
              aria-label="Open navigation"
              onClick={() => setMobileMenu(true)}
            >
              <Menu size={20} />
            </button>
            <span>Workspace</span>
            <span className="slash">/</span>
            <strong>{view}</strong>
          </div>
          <div className="topbar-right">
            <span className="demo-pill">
              <FlaskConical size={12} /> Simulation mode
            </span>
            <span className="topbar-line" />
            <button
              className="icon-button"
              aria-label="View alerts"
              onClick={() => navigate("Alerts")}
            >
              <Bell size={18} />
              {activeAlerts.length > 0 && <i />}
            </button>
            <span className="avatar small">DO</span>
          </div>
        </header>
        <main className="content">
          <div className="page-heading">
            <div>
              <div className="eyebrow">YOUR ENERGY, IN FOCUS</div>
              <h1>
                {view === "Overview"
                  ? "Energy overview"
                  : view === "Generation"
                    ? "Solar generation"
                    : view === "Battery"
                      ? "Battery storage"
                      : view === "Analytics"
                        ? "Energy analytics"
                        : view === "Devices"
                          ? "Device registry"
                          : "Alerts & events"}
                <span className="heading-dot" />
              </h1>
              <p>
                {view === "Overview"
                  ? "A complete picture of your site's energy performance."
                  : view === "Alerts"
                    ? "Understand faults, track recovery, and acknowledge events."
                    : "Inspect simulated site data with full measurement context."}
              </p>
            </div>
            <div className="heading-actions">
              <button
                className="secondary"
                onClick={() => setShowSimulator((s) => !s)}
                aria-expanded={showSimulator}
              >
                <FlaskConical size={15} /> Simulator
              </button>
              <a
                className="primary"
                href={`/api/v1/reports/energy?siteId=${siteId}`}
                download
              >
                <Download size={15} /> Export data
              </a>
            </div>
          </div>
          <div className="context-bar">
            <label className="site-select">
              <Building2 size={17} />
              <select
                aria-label="Select site"
                value={siteId}
                onChange={(e) => selectSite(e.target.value)}
              >
                {sites.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
                {!sites.length && (
                  <option value="factory-01">Dhaka Manufacturing</option>
                )}
              </select>
              <ChevronDown size={14} />
            </label>
            <span className="site-location">
              {data?.site.location ?? "Bangladesh"}
            </span>
            <div className="context-right">
              <span className={`status ${stale ? "warning" : ""}`}>
                <i />
                {stale ? "Data stale" : "Simulation online"}
              </span>
              <span className="context-divider" />
              <span>{date} · Dhaka time</span>
              <button
                className="icon-button"
                aria-label="Refresh data"
                onClick={() => refresh.current()}
              >
                <RefreshCw size={15} />
              </button>
            </div>
          </div>
          {showSimulator && (
            <section
              className="simulation-panel"
              aria-label="Simulation controls"
            >
              <div>
                <strong>
                  <FlaskConical size={16} /> Digital equipment simulator
                </strong>
                <p>
                  Changes synthetic measurements only. Each site has an
                  independent scenario.
                </p>
              </div>
              <label>
                Scenario
                <select
                  aria-label="Simulation scenario"
                  value={data?.scenario ?? "sunny"}
                  onChange={(e) => changeScenario(e.target.value)}
                  disabled={busy || !data}
                >
                  <option value="sunny">Sunny · normal operation</option>
                  <option value="cloudy">Cloudy · reduced generation</option>
                  <option value="night">Night · no solar output</option>
                  <option value="offline">
                    Gateway disconnected · stale data
                  </option>
                  <option value="battery-hot">
                    Battery high temperature · alert
                  </option>
                </select>
              </label>
              {notice && <p role="status">{notice}</p>}
            </section>
          )}
          {error && (
            <div className="error-banner" role="alert">
              <Activity size={17} />
              {error}
              <button onClick={() => refresh.current()}>Retry</button>
              <button onClick={() => setSession("guest")}>Sign in</button>
            </div>
          )}
          {live && stale && (
            <div className="stale-banner" role="status">
              <Radio size={16} /> Last accepted sample:{" "}
              {timestamp(live.measuredAt)} ({Math.floor(age)}s ago). Values
              below are historical. Flow animation paused.
            </div>
          )}
          {!data || !live || !history ? (
            <div className="dashboard-loading" role="status">
              <LoaderCircle className="spin" size={25} />
              <p>Loading site measurements…</p>
            </div>
          ) : (
            <>
              <section className="kpi-grid" aria-label="Current measurements">
                <Kpi
                  label="Solar generation"
                  value={live.solar}
                  unit="kW"
                  icon={<Sun size={19} />}
                  accent="lime"
                  subtitle={`${data.site.capacityKw} kWp installed capacity`}
                  foot={`${number((live.solar / data.site.capacityKw) * 100)}% capacity utilization`}
                  stale={stale}
                />
                <Kpi
                  label="Facility demand"
                  value={live.load}
                  unit="kW"
                  icon={<Building2 size={19} />}
                  accent="blue"
                  subtitle="Total metered facility demand"
                  foot="Solar + battery + grid"
                  stale={stale}
                />
                <Kpi
                  label="Battery charge"
                  value={live.soc}
                  unit="%"
                  icon={<BatteryCharging size={19} />}
                  accent="purple"
                  subtitle={`${number(Math.abs(live.battery))} kW · ${live.battery < 0 ? "Charging" : "Discharging"}`}
                  foot={`${data.site.batteryKwh} kWh storage · ${live.temperature}°C`}
                  stale={stale}
                  soc
                />
                <Kpi
                  label={live.grid < 0 ? "Grid export" : "Grid import"}
                  value={Math.abs(live.grid)}
                  unit="kW"
                  icon={<Cable size={19} />}
                  accent="orange"
                  subtitle={
                    live.grid < 0
                      ? "Surplus energy sent to grid"
                      : "Supplemental energy from grid"
                  }
                  foot="Positive = import · negative = export"
                  stale={stale}
                />
              </section>
              {(view === "Overview" ||
                view === "Generation" ||
                view === "Battery" ||
                view === "Analytics") && (
                <section
                  className={`visual-grid ${view !== "Overview" ? "single" : ""}`}
                >
                  <article className="panel chart-panel">
                    <div className="panel-heading">
                      <div>
                        <h2>
                          {view === "Battery"
                            ? "Battery state of charge"
                            : "Generation & demand"}
                        </h2>
                        <p>
                          {view === "Battery"
                            ? "Stored energy trend · % SOC"
                            : "Power profile · kW"}{" "}
                          <span>· {history.bucketMinutes}-minute averages</span>
                        </p>
                      </div>
                      <div className="range-toggle" aria-label="History range">
                        {["1h", "6h", "24h", "7d"].map((r) => (
                          <button
                            key={r}
                            className={range === r ? "selected" : ""}
                            onClick={() => setRange(r)}
                            aria-pressed={range === r}
                          >
                            {r}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="chart-legend">
                      <span>
                        <i className="lime-dot" />
                        {view === "Battery"
                          ? "Battery SOC"
                          : "Solar generation"}
                      </span>
                      {view !== "Battery" && (
                        <span>
                          <i className="blue-dot" />
                          Load demand
                        </span>
                      )}
                      <span className="chart-timezone">Asia/Dhaka</span>
                    </div>
                    <PowerChart
                      history={history}
                      zone={zone}
                      batteryOnly={view === "Battery"}
                    />
                    <div className="chart-footer">
                      <FlaskConical size={12} /> Simulated measurements ·
                      Missing intervals are not imputed
                    </div>
                  </article>
                  {view === "Overview" && (
                    <article className="panel flow-panel">
                      <div className="panel-heading">
                        <div>
                          <h2>Live energy flow</h2>
                          <p>Where your energy is moving</p>
                        </div>
                        <span
                          className={`live-label ${stale ? "text-amber" : ""}`}
                        >
                          <i />
                          {stale ? "STALE" : "SIMULATED"}
                        </span>
                      </div>
                      <EnergyFlow live={live} stale={stale} />
                    </article>
                  )}
                </section>
              )}
              {view === "Overview" && (
                <section className="lower-grid">
                  <article className="panel">
                    <div className="panel-heading">
                      <div>
                        <h2>
                          Connected equipment{" "}
                          <span className="count">{data.devices.length}</span>
                        </h2>
                        <p>Device connectivity and equipment alarms</p>
                      </div>
                      <button
                        className="text-button"
                        onClick={() => navigate("Devices")}
                      >
                        View all <ArrowRight size={14} />
                      </button>
                    </div>
                    <DeviceTable
                      devices={data.devices}
                      live={live}
                      stale={stale}
                    />
                  </article>
                  <article className="panel insight-panel">
                    <div className="insight-top">
                      <span className="insight-icon">
                        <Leaf size={20} />
                      </span>
                      <span className="badge">TODAY AT A GLANCE</span>
                    </div>
                    <h2>
                      Make every
                      <br />
                      kilowatt count.
                    </h2>
                    <p>
                      Your site generated{" "}
                      <strong>{number(data.energy.solarKwh)} kWh</strong> of
                      solar energy today.
                    </p>
                    <div className="insight-stat">
                      <span>Grid energy imported</span>
                      <strong>
                        {number(data.energy.importKwh)} <small>kWh</small>
                      </strong>
                    </div>
                    <div className="insight-stat">
                      <span>Estimated import cost</span>
                      <strong>৳{number(data.energy.importedCost)}</strong>
                    </div>
                    <small className="tariff-note">
                      Illustrative tariff: ৳12/kWh. No export credit or demand
                      charges.
                    </small>
                    <button
                      className="insight-link"
                      onClick={() => navigate("Analytics")}
                    >
                      Explore energy analytics <ArrowUpRight size={16} />
                    </button>
                  </article>
                </section>
              )}
              {(view === "Generation" ||
                view === "Battery" ||
                view === "Analytics") && (
                <section className="panel analytics-details">
                  <div className="panel-heading">
                    <div>
                      <h2>
                        {view === "Battery"
                          ? "Battery operating context"
                          : "Today’s energy breakdown"}
                      </h2>
                      <p>Local midnight to latest sample · Asia/Dhaka</p>
                    </div>
                    <span className="badge">SIMULATED</span>
                  </div>
                  {view === "Battery" ? (
                    <div className="summary-grid">
                      <Summary
                        label="State of charge"
                        value={`${number(live.soc)}%`}
                      />
                      <Summary
                        label="Battery power"
                        value={`${number(live.battery)} kW`}
                      />
                      <Summary
                        label="Temperature"
                        value={`${number(live.temperature)}°C`}
                      />
                      <Summary
                        label="Nominal capacity"
                        value={`${data.site.batteryKwh} kWh`}
                      />
                    </div>
                  ) : (
                    <div className="summary-grid">
                      <Summary
                        label="Solar generated"
                        value={`${number(data.energy.solarKwh)} kWh`}
                      />
                      <Summary
                        label="Facility consumed"
                        value={`${number(data.energy.demandKwh)} kWh`}
                      />
                      <Summary
                        label="Grid imported"
                        value={`${number(data.energy.importKwh)} kWh`}
                      />
                      <Summary
                        label="Grid exported"
                        value={`${number(data.energy.exportKwh)} kWh`}
                      />
                    </div>
                  )}
                  <div className="method-note">
                    <ShieldCheck size={16} />
                    <p>
                      {view === "Battery"
                        ? "Positive battery power means discharge; negative means charge. SOC and temperature are generated simulator values. Equipment control is disabled."
                        : `${data.energy.method}. Estimated import cost: ৳${number(data.energy.importedCost)} at the illustrative flat tariff of ৳12/kWh. This is not a billing report. No savings or performance ratio is inferred.`}
                    </p>
                  </div>
                </section>
              )}
              {view === "Devices" && (
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h2>
                        Site equipment{" "}
                        <span className="count">{data.devices.length}</span>
                      </h2>
                      <p>
                        Fixed simulator registry · No physical devices connected
                      </p>
                    </div>
                    <label className="search">
                      <Search size={16} />
                      <input
                        aria-label="Search devices"
                        placeholder="Search equipment…"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                      />
                    </label>
                  </div>
                  <DeviceTable
                    devices={data.devices}
                    live={live}
                    stale={stale}
                    query={query}
                  />
                  <div className="registry-details">
                    {data.devices.map((d) => (
                      <div key={d.id}>
                        <strong>{d.name}</strong>
                        <span>{d.serial}</span>
                        <small>{d.id}</small>
                      </div>
                    ))}
                  </div>
                </section>
              )}
              {view === "Alerts" && (
                <section className="panel">
                  <div className="panel-heading">
                    <div>
                      <h2>
                        Alert history{" "}
                        <span className="count">{alerts.length}</span>
                      </h2>
                      <p>
                        {activeAlerts.length} active · Acknowledging does not
                        resolve an equipment condition
                      </p>
                    </div>
                    <button
                      className="secondary"
                      onClick={() => setShowSimulator(true)}
                    >
                      <FlaskConical size={14} /> Test a fault
                    </button>
                  </div>
                  {alerts.length === 0 ? (
                    <div className="empty-state">
                      <CheckCheck size={32} />
                      <h3>All clear for now</h3>
                      <p>
                        No alert events for this site. Use the simulator to test
                        a disconnected gateway or a high battery temperature.
                      </p>
                    </div>
                  ) : (
                    <div className="alert-list">
                      {alerts.map((a) => (
                        <div className="alert-row" key={a.id}>
                          <span className={`alert-symbol ${a.severity}`}>
                            <Bell size={18} />
                          </span>
                          <div>
                            <div className="alert-meta">
                              <span>{a.severity}</span>
                              <span>
                                {a.resolvedAt ? "Resolved" : "Active"}
                              </span>
                              <time>{timestamp(a.firstSeen)}</time>
                            </div>
                            <h3>{a.message}</h3>
                            <p>
                              {a.deviceId}
                              {a.resolvedAt
                                ? ` · Recovered ${timestamp(a.resolvedAt)}`
                                : ` · Last seen ${timestamp(a.lastSeen)}`}
                            </p>
                          </div>
                          <button
                            className="secondary"
                            disabled={!!a.acknowledgedAt || busy}
                            onClick={() => acknowledge(a.id)}
                          >
                            {a.acknowledgedAt ? (
                              <>
                                <CheckCheck size={14} /> Acknowledged
                              </>
                            ) : (
                              "Acknowledge"
                            )}
                          </button>
                        </div>
                      ))}
                    </div>
                  )}
                </section>
              )}
              <div className="data-footer">
                <span>
                  <Radio size={12} /> {connection}{" "}
                  <span className="footer-separator">·</span> Last sample{" "}
                  {timestamp(live.measuredAt)}
                </span>
                <span>
                  <ShieldCheck size={12} /> Quality: {live.quality} · Read-only
                  · Simulation
                </span>
              </div>
            </>
          )}
          <footer className="page-footer">
            <span>
              SolarOps <span className="muted">/</span> Energy intelligence
              platform
            </span>
            <span>
              Built for a brighter tomorrow <Sun size={12} />
            </span>
          </footer>
        </main>
      </div>
      {help && (
        <dialog
          ref={dialogRef}
          className="modal-backdrop"
          aria-labelledby="guide-title"
          onClose={() => setHelp(false)}
          onClick={(e) => {
            if (e.target === e.currentTarget) setHelp(false);
          }}
        >
          <section
            className="guide-modal"
            onClick={(e) => e.stopPropagation()}
            onKeyDown={(e) => {
              if (e.key === "Escape") setHelp(false);
            }}
          >
            <button
              className="modal-close icon-button"
              autoFocus
              aria-label="Close guide"
              onClick={() => setHelp(false)}
            >
              <X size={20} />
            </button>
            <Sun size={32} className="text-lime" />
            <h2 id="guide-title">Welcome to SolarOps</h2>
            <p>
              This workspace uses deterministic synthetic equipment data.
              Nothing here controls real equipment.
            </p>
            <ol>
              <li>Select a site to inspect its independent measurements.</li>
              <li>Open Simulator to change conditions and trigger faults.</li>
              <li>Disconnected gateways become stale after 15 seconds.</li>
              <li>
                Acknowledge alerts to record review; return to a normal scenario
                to resolve faults.
              </li>
              <li>Export the last 24 hours of accepted readings as CSV.</li>
            </ol>
            <p>
              Battery power: positive discharges, negative charges. Grid power:
              positive imports, negative exports.
            </p>
            <button className="primary" onClick={() => setHelp(false)}>
              Got it <ArrowRight size={15} />
            </button>
          </section>
        </dialog>
      )}
    </div>
  );
}

function Kpi({
  label,
  value,
  unit,
  icon,
  accent,
  subtitle,
  foot,
  stale,
  soc,
}: {
  label: string;
  value: number;
  unit: string;
  icon: React.ReactNode;
  accent: string;
  subtitle: string;
  foot: string;
  stale: boolean;
  soc?: boolean;
}) {
  return (
    <article className={`kpi ${accent}`}>
      <div className="kpi-top">
        <span>{label}</span>
        <span className="kpi-icon">{icon}</span>
      </div>
      <div className="kpi-value">
        {number(value)}
        <span>{unit}</span>
      </div>
      <p>{subtitle}</p>
      {soc ? (
        <div className="soc-track">
          <div style={{ width: `${value}%` }} />
        </div>
      ) : (
        <div className="kpi-line" />
      )}
      <div className="kpi-foot">
        {stale ? (
          <Radio size={12} />
        ) : accent === "lime" ? (
          <ArrowUpRight size={12} />
        ) : (
          <ArrowDownLeft size={12} />
        )}
        <span>{stale ? "Last accepted measurement" : foot}</span>
      </div>
    </article>
  );
}
function Summary({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}
