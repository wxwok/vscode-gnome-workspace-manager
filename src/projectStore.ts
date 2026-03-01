import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { ManagedProject, createDefaultProject } from './types';

export class ProjectStore {
  private projects: ManagedProject[] = [];
  private context: vscode.ExtensionContext;

  private readonly _onDidChange = new vscode.EventEmitter<void>();
  readonly onDidChange = this._onDidChange.event;

  /** Custom names for workspace indices */
  private workspaceNames: Record<number, string> = {};

  constructor(context: vscode.ExtensionContext) {
    this.context = context;
    this.load();
  }

  private load(): void {
    this.projects = this.context.globalState.get<ManagedProject[]>('managedProjects', []);
    this.workspaceNames = this.context.globalState.get<Record<number, string>>('workspaceNames', {});
  }

  private async save(): Promise<void> {
    await this.context.globalState.update('managedProjects', this.projects);
    await this.context.globalState.update('workspaceNames', this.workspaceNames);
    this._onDidChange.fire();
  }

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

  getWorkspaceName(index: number): string {
    return this.workspaceNames[index] || `Workspace ${index + 1}`;
  }

  async setWorkspaceName(index: number, name: string): Promise<void> {
    this.workspaceNames[index] = name;
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
