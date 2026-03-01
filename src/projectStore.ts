import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ManagedProject, createDefaultProject } from './types';

const CONFIG_DIR = path.join(os.homedir(), '.config', 'gnome-workspace-manager');
const STATE_FILE = path.join(CONFIG_DIR, 'state.json');

interface StateData {
  version: number;
  projects: ManagedProject[];
  workspaceNames: Record<number, string>;
  lastModified: number;
}

export class ProjectStore {
  private projects: ManagedProject[] = [];
  private context: vscode.ExtensionContext;

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  private workspaceNames: Record<number, string> = {};

  private _watcher: fs.FSWatcher | undefined;
  private _writing = false;
  private _pollInterval: ReturnType<typeof setInterval> | undefined;
  private _debounceTimer: ReturnType<typeof setTimeout> | undefined;
  private _lastKnownMtime = 0;

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.ensureConfigDir();
    this.load();
    this.startWatching();
  }

  dispose(): void {
    this._watcher?.close();
    if (this._pollInterval) { clearInterval(this._pollInterval); }
    if (this._debounceTimer) { clearTimeout(this._debounceTimer); }
  }

  // ── File-based persistence with cross-window sync ──

  private ensureConfigDir(): void {
    if (!fs.existsSync(CONFIG_DIR)) {
      fs.mkdirSync(CONFIG_DIR, { recursive: true });
    }
  }

  private load(): void {
    if (fs.existsSync(STATE_FILE)) {
      try {
        const raw = fs.readFileSync(STATE_FILE, 'utf-8');
        const data: StateData = JSON.parse(raw);
        this.projects = data.projects || [];
        this.workspaceNames = data.workspaceNames || {};
        this._lastKnownMtime = fs.statSync(STATE_FILE).mtimeMs;
        return;
      } catch { /* fall through to globalState migration */ }
    }

    // Migrate from globalState on first run
    const gsProjects = this.context.globalState.get<ManagedProject[]>('managedProjects');
    const gsNames = this.context.globalState.get<Record<number, string>>('workspaceNames');
    if (gsProjects && gsProjects.length > 0) {
      this.projects = gsProjects;
      this.workspaceNames = gsNames || {};
      this.writeFile();
    }
  }

  private writeFile(): void {
    this.ensureConfigDir();
    const data: StateData = {
      version: 1,
      projects: this.projects,
      workspaceNames: this.workspaceNames,
      lastModified: Date.now(),
    };
    this._writing = true;
    fs.writeFileSync(STATE_FILE, JSON.stringify(data, null, 2), 'utf-8');
    try {
      this._lastKnownMtime = fs.statSync(STATE_FILE).mtimeMs;
    } catch { /* ignore */ }
    setTimeout(() => { this._writing = false; }, 500);
  }

  private async save(): Promise<void> {
    this.writeFile();
    this._onDidChange.fire();
  }

  private startWatching(): void {
    if (!fs.existsSync(STATE_FILE)) {
      this.writeFile();
    }

    try {
      this._watcher = fs.watch(STATE_FILE, { persistent: false }, (_event) => {
        this.onExternalChange();
      });
      this._watcher.on('error', () => {
        this._watcher?.close();
        this._watcher = undefined;
        this.startPolling();
      });
    } catch {
      this.startPolling();
    }
  }

  private startPolling(): void {
    this._pollInterval = setInterval(() => {
      try {
        if (!fs.existsSync(STATE_FILE)) { return; }
        const mtime = fs.statSync(STATE_FILE).mtimeMs;
        if (mtime > this._lastKnownMtime) {
          this.onExternalChange();
        }
      } catch { /* ignore */ }
    }, 3000);
  }

  /** Called when the shared state file is modified (by another window). */
  private onExternalChange(): void {
    if (this._writing) { return; }

    if (this._debounceTimer) { clearTimeout(this._debounceTimer); }
    this._debounceTimer = setTimeout(() => {
      try {
        if (!fs.existsSync(STATE_FILE)) { return; }
        const mtime = fs.statSync(STATE_FILE).mtimeMs;
        if (mtime <= this._lastKnownMtime) { return; }

        const raw = fs.readFileSync(STATE_FILE, 'utf-8');
        const data: StateData = JSON.parse(raw);
        this.projects = data.projects || [];
        this.workspaceNames = data.workspaceNames || {};
        this._lastKnownMtime = mtime;
        this._onDidChange.fire();
      } catch { /* ignore parse errors during concurrent writes */ }
    }, 300);
  }

  // ── Queries ──

  getAll(): ManagedProject[] {
    return [...this.projects];
  }

  getById(id: string): ManagedProject | undefined {
    return this.projects.find(p => p.id === id);
  }

  getByPath(projectPath: string): ManagedProject | undefined {
    const normalized = path.normalize(projectPath);
    return this.projects.find(p => path.normalize(p.path) === normalized);
  }

  getByWorkspace(workspace: number): ManagedProject[] {
    return this.projects.filter(p => p.targetWorkspace === workspace);
  }

  getPinned(): ManagedProject[] {
    return this.projects.filter(p => p.pinned);
  }

  getByGroup(group: string): ManagedProject[] {
    return this.projects.filter(p => p.group === group);
  }

  getGroups(): string[] {
    const groups = new Set(this.projects.map(p => p.group).filter(Boolean));
    return [...groups].sort();
  }

  // ── Mutations ──

  async add(project: ManagedProject): Promise<ManagedProject> {
    const existing = this.getByPath(project.path);
    if (existing) {
      return existing;
    }
    this.projects.push(project);
    await this.save();
    return project;
  }

  async addFromPath(projectPath: string, workspace?: number): Promise<ManagedProject> {
    const project = createDefaultProject(projectPath);
    if (workspace !== undefined) {
      project.targetWorkspace = workspace;
    }
    return this.add(project);
  }

  async update(id: string, updates: Partial<ManagedProject>): Promise<ManagedProject | undefined> {
    const idx = this.projects.findIndex(p => p.id === id);
    if (idx === -1) { return undefined; }
    this.projects[idx] = { ...this.projects[idx], ...updates, id };
    await this.save();
    return this.projects[idx];
  }

  async remove(id: string): Promise<boolean> {
    const idx = this.projects.findIndex(p => p.id === id);
    if (idx === -1) { return false; }
    this.projects.splice(idx, 1);
    await this.save();
    return true;
  }

  async updateLastOpened(id: string): Promise<void> {
    await this.update(id, { lastOpened: Date.now() });
  }

  async togglePin(id: string): Promise<void> {
    const project = this.getById(id);
    if (project) {
      await this.update(id, { pinned: !project.pinned });
    }
  }

  // ── Workspace names ──

  getWorkspaceName(index: number): string {
    return this.workspaceNames[index] || `Workspace ${index + 1}`;
  }

  async setWorkspaceName(index: number, name: string): Promise<void> {
    if (name && name.trim()) {
      this.workspaceNames[index] = name.trim();
    } else {
      delete this.workspaceNames[index];
    }
    await this.save();
  }

  // ── Import/Export ──

  async exportToFile(): Promise<void> {
    const uri = await vscode.window.showSaveDialog({
      defaultUri: vscode.Uri.file(path.join(
        process.env.HOME || '~',
        'gwm-config.json'
      )),
      filters: { 'JSON': ['json'] },
    });
    if (!uri) { return; }

    const data = {
      version: 1,
      projects: this.projects,
      workspaceNames: this.workspaceNames,
      exportedAt: new Date().toISOString(),
    };

    fs.writeFileSync(uri.fsPath, JSON.stringify(data, null, 2), 'utf-8');
    vscode.window.showInformationMessage(`Exported ${this.projects.length} projects to ${uri.fsPath}`);
  }

  async importFromFile(): Promise<void> {
    const uris = await vscode.window.showOpenDialog({
      canSelectMany: false,
      filters: { 'JSON': ['json'] },
    });
    if (!uris || uris.length === 0) { return; }

    try {
      const raw = fs.readFileSync(uris[0].fsPath, 'utf-8');
      const data = JSON.parse(raw);

      if (data.version !== 1 || !Array.isArray(data.projects)) {
        vscode.window.showErrorMessage('Invalid configuration file format.');
        return;
      }

      const action = await vscode.window.showQuickPick(
        ['Merge with existing', 'Replace all'],
        { placeHolder: 'How should the imported projects be handled?' }
      );
      if (!action) { return; }

      if (action === 'Replace all') {
        this.projects = data.projects;
      } else {
        for (const imported of data.projects as ManagedProject[]) {
          if (!this.getByPath(imported.path)) {
            this.projects.push(imported);
          }
        }
      }

      if (data.workspaceNames) {
        this.workspaceNames = { ...this.workspaceNames, ...data.workspaceNames };
      }

      await this.save();
      vscode.window.showInformationMessage(`Imported projects successfully.`);
    } catch (e) {
      vscode.window.showErrorMessage(`Failed to import: ${e}`);
    }
  }

  // ── Project scanning ──

  async scanDirectory(dirPath: string, depth: number, indicators: string[]): Promise<string[]> {
    const found: string[] = [];
    await this.scanRecursive(dirPath, depth, indicators, found);
    return found;
  }

  private async scanRecursive(
    dirPath: string, depth: number, indicators: string[], found: string[]
  ): Promise<void> {
    if (depth <= 0) { return; }

    try {
      const entries = fs.readdirSync(dirPath, { withFileTypes: true });

      for (const indicator of indicators) {
        const hasIndicator = entries.some(e => {
          if (indicator.startsWith('*')) {
            return e.name.endsWith(indicator.substring(1));
          }
          return e.name === indicator;
        });
        if (hasIndicator && !this.getByPath(dirPath)) {
          found.push(dirPath);
          return;
        }
      }

      for (const entry of entries) {
        if (!entry.isDirectory()) { continue; }
        if (entry.name.startsWith('.') || entry.name === 'node_modules' || entry.name === '__pycache__') {
          continue;
        }
        await this.scanRecursive(path.join(dirPath, entry.name), depth - 1, indicators, found);
      }
    } catch {
      // Permission denied or inaccessible
    }
  }

  // ── Health check ──

  checkHealth(): { valid: ManagedProject[]; missing: ManagedProject[] } {
    const valid: ManagedProject[] = [];
    const missing: ManagedProject[] = [];

    for (const project of this.projects) {
      if (fs.existsSync(project.path)) {
        valid.push(project);
      } else {
        missing.push(project);
      }
    }

    return { valid, missing };
  }
}
