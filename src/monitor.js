// Polls everything on a timer and keeps the latest result in memory.
// The web page only ever reads the cached snapshot, so many open tabs cost nothing.
import fs from 'node:fs';
import { parseConfigText, ensureConfigFile, servicesFromLabels, DEFAULT_SETTINGS } from './config.js';
import { runCheck } from './checks.js';
import { listContainers, summarizeContainers, autoContainerPatterns } from './docker.js';
import { StatsReader } from './stats.js';
import { fetchMachineStats } from './agent.js';

const EMPTY_CONFIG = {
  title: 'Homelab Hub',
  subtitle: '',
  settings: { ...DEFAULT_SETTINGS },
  stats: { disks: [], machines: [] },
  groups: []
};

export class Monitor {
  /**
   * @param {object} o
   * @param {string} o.configPath         YAML file to edit
   * @param {string} [o.defaultConfigPath] bundled example copied on first start
   * @param {string} [o.dockerHost]       DOCKER_HOST value; empty = no container health
   * @param {string} [o.procPath]
   * @param {string} [o.sysPath]
   * @param {Function} [o.check]          override for tests: (check, timeoutMs) => result
   * @param {Function} [o.containers]     override for tests: () => Promise<container[]>
   * @param {object}   [o.statsReader]    override for tests: {read(disks)}
   * @param {Function} [o.fetchMachine]   override for tests: (machine, timeoutMs) => stats of another machine
   */
  constructor(o) {
    this.configPath = o.configPath;
    this.defaultConfigPath = o.defaultConfigPath;
    this.dockerHost = o.dockerHost ?? '';
    this.check = o.check ?? runCheck;
    this.listContainers = o.containers ?? (() => listContainers(this.dockerHost));
    this.statsReader = o.statsReader ?? new StatsReader({ procPath: o.procPath, sysPath: o.sysPath });
    this.fetchMachine = o.fetchMachine ?? fetchMachineStats;
    this.machineStats = []; // other machines: [{name, stats, error}]
    this.config = EMPTY_CONFIG;
    this.configError = null;
    this.configLoadedAt = null;
    this.lastConfigText = null;
    this.startedAt = Date.now();
    this.timer = null;
    this.stopped = false;
    this.results = new Map(); // service id -> {status, detail, code, ms, checkedAt}
    this.containerSummary = new Map(); // service id -> summary
    this.discovered = [];
    this.labelGroups = []; // cards made from Docker labels: [{name, services}]
    this.labelErrors = [];
    this.stats = null;
    this.statsError = null;
    this.statsAt = null;
    this.statsBusy = false;
    this.statsTimer = null;
    this.dockerError = null;
    this.checkedAt = null;
    this.readConfigFile = () => ensureConfigFile(this.configPath, this.defaultConfigPath);
  }

  /** Re-reads the YAML when it changed. A broken file keeps the last good config. */
  reloadConfig() {
    let text;
    const file = this.readConfigFile();
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      this.configError = { message: `Cannot read ${file}: ${err.code ?? err.message}`, lines: [] };
      return;
    }
    if (text === this.lastConfigText) {
      // file readable again and unchanged: a read error from before no longer applies
      if (this.configError && this.configError.lines.length === 0) this.configError = null;
      return;
    }
    this.lastConfigText = text;
    const { config, errors } = parseConfigText(text);
    if (config) {
      this.config = config;
      this.configError = null;
      this.configLoadedAt = Date.now();
      // forget results of services that no longer exist
      const ids = new Set(config.groups.flatMap((g) => g.services.map((s) => s.id)));
      for (const id of [...this.results.keys()]) if (!ids.has(id) && !id.startsWith('d:')) this.results.delete(id);
      console.log(`[config] loaded ${file}: ${ids.size} services`);
    } else {
      this.configError = {
        message: this.configLoadedAt
          ? 'The config file has errors. Showing the last working version until it is fixed.'
          : 'The config file has errors, so there is nothing to show yet.',
        lines: errors
      };
      console.warn(`[config] ${errors.length} error(s) in ${file}:\n  - ${errors.join('\n  - ')}`);
    }
  }

  /** The groups of the YAML plus the cards made from Docker labels (added to the group of the same name, or as new groups). */
  groups() {
    const { config } = this;
    if (this.labelGroups.length === 0) return config.groups;
    const out = config.groups.map((g) => ({ ...g, services: [...g.services] }));
    for (const lg of this.labelGroups) {
      const own = out.find((g) => g.name === lg.name);
      // a card the YAML already has (same name in the same group) wins over the label
      const fresh = lg.services.filter((s) => !own?.services.some((x) => x.name === s.name));
      if (own) own.services.push(...fresh);
      else out.push({ id: `d:${lg.name}`, name: lg.name, icon: '', services: fresh });
    }
    return out;
  }

  async tick() {
    this.reloadConfig();
    const { config } = this;
    const timeoutMs = config.settings.timeoutSeconds * 1000;

    const wantsContainers = config.groups.some((g) => g.services.some((s) => s.containers.length > 0 || s.autoContainers));
    const containersPromise =
      wantsContainers || this.dockerHost
        ? this.listContainers().then(
            (list) => ({ list }),
            (err) => ({ error: err.message })
          )
        : Promise.resolve({ list: null });
    // While the faster stats timer runs (start()), it owns CPU, memory, network and storage. Without it
    // (tests, or one tick on its own) the stats are read here, once per cycle.
    const statsPromise = this.statsTimer ? Promise.resolve() : this.refreshStats();

    // Docker first: its labels can add cards, which are then checked like the others.
    const docker = await containersPromise;
    if (docker.list && config.settings.dockerLabels !== false) {
      const made = servicesFromLabels(docker.list, config);
      this.labelGroups = made.groups;
      this.labelErrors = made.errors;
    } else if (docker.list || config.settings.dockerLabels === false) {
      this.labelGroups = [];
      this.labelErrors = [];
    } // Docker unreachable: keep the cards from the last good answer
    const services = this.groups().flatMap((g) => g.services);
    const labelIds = new Set(services.filter((s) => s.fromDocker).map((s) => s.id));
    for (const id of [...this.results.keys()]) if (id.startsWith('d:') && !labelIds.has(id)) this.results.delete(id);

    await Promise.all(
      services.map(async (svc) => {
        const result = await this.check(svc.check, timeoutMs);
        this.results.set(svc.id, { ...result, checkedAt: Date.now() });
      })
    );

    if (docker.list) {
      this.discovered = docker.list;
      this.dockerError = null;
      for (const svc of services) {
        if (svc.containers.length > 0) {
          this.containerSummary.set(svc.id, summarizeContainers(svc.containers, docker.list));
        } else if (svc.autoContainers) {
          // automatic: a card only gets a badge when a container really matches (no red "not found")
          const found = summarizeContainers(autoContainerPatterns(svc.name), docker.list);
          if (found.state === 'missing') this.containerSummary.delete(svc.id);
          else this.containerSummary.set(svc.id, found);
        } else {
          this.containerSummary.delete(svc.id);
        }
      }
    } else {
      this.discovered = [];
      this.containerSummary.clear();
      this.dockerError = docker.error ?? (wantsContainers ? 'No Docker connection configured (DOCKER_HOST)' : null);
    }

    await statsPromise;
    this.checkedAt = Date.now();
  }

  /** Reads CPU, memory, load, network and storage. Cheap (a few files), so it runs on its own, faster timer. */
  async refreshStats() {
    if (this.statsBusy) return; // the last read is still running (slow disk or PowerShell): skip this round
    this.statsBusy = true;
    try {
      const { config } = this;
      const machines = config.stats.machines ?? [];
      const timeoutMs = config.settings.timeoutSeconds * 1000;
      // this machine and the others at the same time; one that fails never holds up the rest
      const [own, others] = await Promise.all([
        this.statsReader.read(config.stats.disks, { interfaces: config.stats.network }).then(
          (stats) => ({ stats }),
          (err) => ({ error: err.message })
        ),
        Promise.all(
          machines.map((m) =>
            this.fetchMachine(m, timeoutMs).then(
              (stats) => ({ name: m.name, stats, error: null }),
              (err) => ({ name: m.name, stats: null, error: err.message })
            )
          )
        )
      ]);
      this.machineStats = others;
      this.stats = own.stats ?? null;
      this.statsError = own.error ?? null;
      if (own.stats) this.statsAt = Date.now();
    } catch (err) {
      this.stats = null;
      this.statsError = err.message;
    } finally {
      this.statsBusy = false;
    }
  }

  /** What the web page gets. Check targets (internal addresses) are not included. */
  snapshot() {
    const { config } = this;
    let up = 0;
    let down = 0;
    let unknown = 0;
    const groups = this.groups().map((g) => ({
      id: g.id,
      name: g.name,
      icon: g.icon,
      services: g.services.map((s) => {
        const r = this.results.get(s.id);
        // no check configured (check: none): a plain link, without a dot and not counted anywhere
        const status = !s.check ? 'none' : r ? r.status : 'pending';
        if (status === 'up') up++;
        else if (status === 'down') down++;
        else if (status !== 'none') unknown++;
        const watch = s.containers.length > 0 || s.autoContainers;
        const c = watch ? this.containerSummary.get(s.id) ?? null : null;
        // automatic matching: a badge only once a container was found (no "?" on every card when Docker is unreachable)
        const showBadge = s.containers.length > 0 || (s.autoContainers && c != null);
        return {
          id: s.id,
          name: s.name,
          url: s.url,
          localUrl: s.localUrl,
          description: s.description,
          icon: s.icon,
          status,
          detail: r?.detail ?? '',
          code: r?.code ?? null,
          ms: r?.ms ?? null,
          checkedAt: r?.checkedAt ?? null,
          watchContainers: showBadge,
          containers: c,
          ...(s.fromDocker ? { fromDocker: true } : {})
        };
      })
    }));
    return {
      title: config.title,
      subtitle: config.subtitle,
      generatedAt: Date.now(),
      checkedAt: this.checkedAt,
      language: config.settings.language ?? 'auto',
      checkIntervalSeconds: config.settings.checkIntervalSeconds,
      statsIntervalSeconds: config.settings.statsIntervalSeconds,
      statsAt: this.statsAt ?? null,
      configError: this.configError,
      configLoadedAt: this.configLoadedAt,
      summary: { up, down, unknown, total: up + down + unknown },
      groups,
      stats: this.stats,
      statsLabel: config.stats.name,
      machines: this.machineStats,
      statsError: this.statsError,
      dockerError: this.dockerError
    };
  }

  /** Containers Docker reports, for fixing `containers:` patterns in the YAML. */
  containers() {
    return { error: this.dockerError, labelErrors: this.labelErrors, containers: this.discovered };
  }

  start() {
    // stats: own timer, every statsIntervalSeconds (the value is read again each round, so a YAML edit applies)
    const statsLoop = async () => {
      await this.refreshStats();
      if (!this.stopped) {
        this.statsTimer = setTimeout(statsLoop, this.config.settings.statsIntervalSeconds * 1000);
        this.statsTimer.unref?.();
      }
    };
    this.statsTimer = true; // from now on tick() leaves the stats to the loop above
    this.reloadConfig();
    statsLoop();

    const loop = async () => {
      try {
        await this.tick();
      } catch (err) {
        console.error('[monitor] tick failed:', err);
      }
      if (!this.stopped) {
        this.timer = setTimeout(loop, this.config.settings.checkIntervalSeconds * 1000);
        this.timer.unref?.();
      }
    };
    this.firstTick = loop();
    return this.firstTick;
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    if (typeof this.statsTimer === 'object') clearTimeout(this.statsTimer);
  }
}
