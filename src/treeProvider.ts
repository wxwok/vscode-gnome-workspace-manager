import * as vscode from 'vscode';
import * as fs from 'fs';
import { ProjectStore } from './projectStore';
import { GnomeHelper } from './gnomeHelper';
import { ManagedProject, WindowInfo, getWindowMatchNames } from './types';

const DRAG_MIME = 'application/vnd.code.tree.gwmproject';

// ── Tree item types (exported so extension.ts and drag-drop can inspect them) ──

export class WorkspaceItem extends vscode.TreeItem {
  constructor(
    public readonly workspaceIndex: number,
    label: string,
    public readonly isCurrent: boolean,
    projectCount: number,
  ) {
    super(label, projectCount > 0
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed
    );
    this.contextValue = 'workspace';
    this.iconPath = new vscode.ThemeIcon(
      isCurrent ? 'layout-activitybar-left' : 'layout-panel',
    );
    this.description = isCurrent ? '● current' : `${projectCount} project${projectCount === 1 ? '' : 's'}`;
  }
}

export class ProjectItem extends vscode.TreeItem {
  constructor(
    public readonly project: ManagedProject,
    public readonly isOpen: boolean,
  ) {
    super(project.name, vscode.TreeItemCollapsibleState.None);
    this.contextValue = project.pinned ? 'pinnedProject' : 'project';
    this.description = this.buildDescription();
    this.tooltip = this.buildTooltip();
    this.iconPath = this.getIcon();

    this.command = {
      command: 'gwm.switchToProject',
      title: 'Switch to Project',
      arguments: [project],
    };
  }

  private buildDescription(): string {
    const parts: string[] = [];
    if (this.isOpen) { parts.push('● open'); }
    if (this.project.pinned) { parts.push('📌'); }
    if (this.project.group) { parts.push(`[${this.project.group}]`); }
    return parts.join(' ');
  }

  private buildTooltip(): string {
    const lines = [
      this.project.name,
      `Path: ${this.project.path}`,
      `Workspace: ${this.project.targetWorkspace >= 0 ? this.project.targetWorkspace + 1 : 'Unassigned'}`,
    ];
    if (this.project.group) { lines.push(`Group: ${this.project.group}`); }
    if (this.project.notes) { lines.push(`Notes: ${this.project.notes}`); }
    if (this.project.lastOpened) {
      lines.push(`Last opened: ${new Date(this.project.lastOpened).toLocaleString()}`);
    }
    return lines.join('\n');
  }

  private getIcon(): vscode.ThemeIcon {
    if (!fs.existsSync(this.project.path)) {
      return new vscode.ThemeIcon('warning', new vscode.ThemeColor('errorForeground'));
    }
    if (this.project.pinned) {
      return new vscode.ThemeIcon('pinned', this.project.color
        ? new vscode.ThemeColor('charts.blue')
        : undefined
      );
    }
    return new vscode.ThemeIcon(this.isOpen ? 'folder-opened' : 'folder');
  }
}

export class UnassignedHeader extends vscode.TreeItem {
  constructor(count: number) {
    super('Unassigned', count > 0
      ? vscode.TreeItemCollapsibleState.Expanded
      : vscode.TreeItemCollapsibleState.Collapsed
    );
    this.contextValue = 'unassignedHeader';
    this.iconPath = new vscode.ThemeIcon('question');
    this.description = `${count} project${count === 1 ? '' : 's'}`;
  }
}

// ── Drag-and-drop controller: drag projects between workspaces ──

export class WorkspaceDragDropController implements vscode.TreeDragAndDropController<vscode.TreeItem> {
  readonly dropMimeTypes = [DRAG_MIME];
  readonly dragMimeTypes = [DRAG_MIME];

  constructor(private store: ProjectStore) {}

  handleDrag(
    source: readonly vscode.TreeItem[],
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): void {
    const ids: string[] = [];
    for (const item of source) {
      if (item instanceof ProjectItem) {
        ids.push(item.project.id);
      }
    }
    if (ids.length > 0) {
      dataTransfer.set(DRAG_MIME, new vscode.DataTransferItem(JSON.stringify(ids)));
    }
  }

  async handleDrop(
    target: vscode.TreeItem | undefined,
    dataTransfer: vscode.DataTransfer,
    _token: vscode.CancellationToken,
  ): Promise<void> {
    const raw = dataTransfer.get(DRAG_MIME);
    if (!raw || !target) { return; }

    let targetWorkspace: number;
    if (target instanceof WorkspaceItem) {
      targetWorkspace = target.workspaceIndex;
    } else if (target instanceof UnassignedHeader) {
      targetWorkspace = -1;
    } else if (target instanceof ProjectItem) {
      // Dropped onto a sibling project — use that project's workspace
      targetWorkspace = target.project.targetWorkspace;
    } else {
      return;
    }

    const ids: string[] = JSON.parse(raw.value);
    for (const id of ids) {
      await this.store.update(id, { targetWorkspace });
    }
  }
}

// ── Workspace Overview Tree Provider ──

export class WorkspaceTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private openWindows: WindowInfo[] = [];

  constructor(
    private store: ProjectStore,
    private gnome: GnomeHelper,
  ) {
    store.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  async refreshWithWindows(): Promise<void> {
    this.openWindows = await this.gnome.findEditorWindows();
    this.refresh();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (!element) {
      return this.getRootItems();
    }
    if (element instanceof WorkspaceItem) {
      return this.getWorkspaceProjects(element.workspaceIndex);
    }
    if (element instanceof UnassignedHeader) {
      return this.getUnassignedProjects();
    }
    return [];
  }

  private async getRootItems(): Promise<vscode.TreeItem[]> {
    const workspaces = await this.gnome.getWorkspaces();
    const items: vscode.TreeItem[] = [];

    for (const ws of workspaces) {
      const projects = this.store.getByWorkspace(ws.index);
      const name = this.store.getWorkspaceName(ws.index);
      items.push(new WorkspaceItem(ws.index, name, ws.isCurrent, projects.length));
    }

    const unassigned = this.store.getAll().filter(p => p.targetWorkspace < 0);
    if (unassigned.length > 0) {
      items.push(new UnassignedHeader(unassigned.length));
    }

    return items;
  }

  private getWorkspaceProjects(workspace: number): vscode.TreeItem[] {
    const projects = this.store.getByWorkspace(workspace);
    return this.sortProjects(projects).map(p =>
      new ProjectItem(p, this.isProjectOpen(p))
    );
  }

  private getUnassignedProjects(): vscode.TreeItem[] {
    const projects = this.store.getAll().filter(p => p.targetWorkspace < 0);
    return this.sortProjects(projects).map(p =>
      new ProjectItem(p, this.isProjectOpen(p))
    );
  }

  private isProjectOpen(project: ManagedProject): boolean {
    const names = getWindowMatchNames(project);
    return this.openWindows.some(w => names.some(n => w.title.includes(n)));
  }

  private sortProjects(projects: ManagedProject[]): ManagedProject[] {
    return [...projects].sort((a, b) => {
      if (a.pinned !== b.pinned) { return a.pinned ? -1 : 1; }
      return a.name.localeCompare(b.name);
    });
  }
}

// ── Projects List Tree Provider ──

export class ProjectTreeProvider implements vscode.TreeDataProvider<vscode.TreeItem> {
  private readonly _onDidChangeTreeData = new vscode.EventEmitter<vscode.TreeItem | undefined>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private openWindows: WindowInfo[] = [];

  constructor(
    private store: ProjectStore,
    private gnome: GnomeHelper,
  ) {
    store.onDidChange(() => this.refresh());
  }

  refresh(): void {
    this._onDidChangeTreeData.fire(undefined);
  }

  async refreshWithWindows(): Promise<void> {
    this.openWindows = await this.gnome.findEditorWindows();
    this.refresh();
  }

  getTreeItem(element: vscode.TreeItem): vscode.TreeItem {
    return element;
  }

  async getChildren(element?: vscode.TreeItem): Promise<vscode.TreeItem[]> {
    if (element) { return []; }

    const projects = this.store.getAll();
    if (projects.length === 0) {
      const item = new vscode.TreeItem('No projects added yet');
      item.description = 'Use + to add current project';
      item.iconPath = new vscode.ThemeIcon('info');
      return [item];
    }

    const groups = this.store.getGroups();
    if (groups.length > 0) {
      return this.getGroupedItems(projects, groups);
    }

    return this.sortProjects(projects).map(p =>
      new ProjectItem(p, this.isProjectOpen(p))
    );
  }

  private getGroupedItems(projects: ManagedProject[], groups: string[]): vscode.TreeItem[] {
    const items: vscode.TreeItem[] = [];
    const ungrouped = projects.filter(p => !p.group);

    for (const group of groups) {
      const groupProjects = this.store.getByGroup(group);
      const header = new vscode.TreeItem(group, vscode.TreeItemCollapsibleState.Expanded);
      header.iconPath = new vscode.ThemeIcon('folder');
      header.description = `${groupProjects.length}`;
      items.push(header);

      for (const p of this.sortProjects(groupProjects)) {
        items.push(new ProjectItem(p, this.isProjectOpen(p)));
      }
    }

    if (ungrouped.length > 0) {
      for (const p of this.sortProjects(ungrouped)) {
        items.push(new ProjectItem(p, this.isProjectOpen(p)));
      }
    }

    return items;
  }

  private isProjectOpen(project: ManagedProject): boolean {
    const names = getWindowMatchNames(project);
    return this.openWindows.some(w => names.some(n => w.title.includes(n)));
  }

  private sortProjects(projects: ManagedProject[]): ManagedProject[] {
    return [...projects].sort((a, b) => {
      if (a.pinned !== b.pinned) { return a.pinned ? -1 : 1; }
      return a.name.localeCompare(b.name);
    });
  }
}
