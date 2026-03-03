import * as vscode from 'vscode';
import * as path from 'path';
import { GnomeHelper } from './gnomeHelper';
import { ProjectStore } from './projectStore';
import {
  WorkspaceTreeProvider, ProjectTreeProvider,
  WorkspaceDragDropController, WorkspaceItem, ProjectItem,
} from './treeProvider';
import { ManagementPanel } from './webviewPanel';
import { StatusBarManager } from './statusBar';
import { ManagedProject, getWindowMatchNames } from './types';

let outputChannel: vscode.OutputChannel;

export function activate(context: vscode.ExtensionContext) {
  outputChannel = vscode.window.createOutputChannel('GNOME Workspace Manager');
  context.subscriptions.push(outputChannel);

  const gnome = new GnomeHelper(outputChannel);
  const store = new ProjectStore(context);
  const workspaceTree = new WorkspaceTreeProvider(store, gnome);
  const projectTree = new ProjectTreeProvider(store, gnome);
  const statusBar = new StatusBarManager(gnome);

  context.subscriptions.push(statusBar);
  context.subscriptions.push({ dispose: () => store.dispose() });

  // Register tree views with drag-and-drop support
  const dragDrop = new WorkspaceDragDropController(store);
  const workspaceTreeView = vscode.window.createTreeView('gwm.workspaceOverview', {
    treeDataProvider: workspaceTree,
    dragAndDropController: dragDrop,
    canSelectMany: true,
  });
  const projectTreeView = vscode.window.createTreeView('gwm.projects', {
    treeDataProvider: projectTree,
  });
  context.subscriptions.push(workspaceTreeView, projectTreeView);

  // Initialize GNOME helper then perform startup tasks
  gnome.init().then(async () => {
    await gnome.ensureTools();
    workspaceTree.refreshWithWindows();
    projectTree.refreshWithWindows();
    statusBar.update();

    // Auto-detect .code-workspace file for the current project
    const wsFile = vscode.workspace.workspaceFile;
    if (wsFile && wsFile.scheme === 'file') {
      const folder = getCurrentWorkspaceFolder();
      if (folder) {
        const project = store.getByPath(folder);
        if (project && project.workspaceFile !== wsFile.fsPath) {
          const updates: Partial<ManagedProject> = { workspaceFile: wsFile.fsPath };
          const folderName = folder.split('/').pop() || '';
          const wsName = (wsFile.fsPath.split('/').pop() || '').replace(/\.code-workspace$/, '');
          if (wsName && project.name === folderName) {
            updates.name = wsName;
          }
          store.update(project.id, updates);
        }
      }
    }

    const config = vscode.workspace.getConfiguration('gnomeWorkspaceManager');
    if (config.get<boolean>('autoPlaceOnStartup', true)) {
      const delay = config.get<number>('startupDelay', 2000);
      setTimeout(() => autoPlaceCurrentProject(store, gnome), delay);
    }

    // Auto-open projects marked with autoOpen
    const autoOpenProjects = store.getAll().filter(p => p.autoOpen);
    for (const project of autoOpenProjects) {
      const names = getWindowMatchNames(project);
      const openWindows = await gnome.findEditorWindows(names);
      if (openWindows.length === 0) {
        gnome.openInEditor(project.workspaceFile || project.path);
        store.updateLastOpened(project.id);
      }
    }
  });

  // ── Commands ──

  const commands: Array<[string, (...args: any[]) => any]> = [
    ['gwm.openManagement', () => {
      ManagementPanel.show(context.extensionUri, store, gnome);
    }],

    ['gwm.placeAll', async () => {
      const projects = store.getAll().filter(p => p.targetWorkspace >= 0);
      if (projects.length === 0) {
        vscode.window.showInformationMessage('No projects with assigned workspaces.');
        return;
      }
      let placed = 0;
      for (const project of projects) {
        const names = getWindowMatchNames(project);
        let success = false;
        for (const name of names) {
          success = await gnome.moveWindowByTitle(name, project.targetWorkspace);
          if (success) { break; }
        }
        if (success) { placed++; }
      }
      vscode.window.showInformationMessage(`Placed ${placed}/${projects.length} project windows.`);
      refreshAll();
    }],

    ['gwm.placeCurrent', async () => {
      await autoPlaceCurrentProject(store, gnome);
    }],

    ['gwm.addCurrentProject', async () => {
      const folder = getCurrentWorkspaceFolder();
      if (!folder) {
        vscode.window.showWarningMessage('No workspace folder open.');
        return;
      }
      const existing = store.getByPath(folder);
      if (existing) {
        vscode.window.showInformationMessage(`"${existing.name}" is already managed.`);
        return;
      }

      const workspaces = await gnome.getWorkspaces();
      const wsItems = [
        { label: 'Unassigned', description: 'Assign later', value: -1 },
        ...workspaces.map(ws => ({
          label: store.getWorkspaceName(ws.index),
          description: ws.isCurrent ? '(current)' : '',
          value: ws.index,
        })),
      ];

      const picked = await vscode.window.showQuickPick(wsItems, {
        placeHolder: 'Assign to which workspace?',
      });
      if (!picked) { return; }

      const currentWsFile = vscode.workspace.workspaceFile;
      const wsFilePath = currentWsFile?.scheme === 'file' ? currentWsFile.fsPath : '';
      const wsName = wsFilePath
        ? (wsFilePath.split('/').pop() || '').replace(/\.code-workspace$/, '')
        : '';

      const project = await store.addFromPath(folder, picked.value);
      if (wsFilePath) {
        await store.update(project.id, {
          workspaceFile: wsFilePath,
          name: wsName || project.name,
        });
      }
      const displayName = wsName || project.name;
      vscode.window.showInformationMessage(`Added "${displayName}" to workspace manager.`);
      refreshAll();
    }],

    ['gwm.assignWorkspace', async (arg?: ManagedProject) => {
      let project: ManagedProject | undefined = arg;
      if (arg && arg instanceof ProjectItem) {
        project = (arg as any).project;
      }
      if (!project || !project.id) {
        project = await pickProject(store, 'Select project to assign');
      }
      if (!project) { return; }

      const workspaces = await gnome.getWorkspaces();
      const wsItems = [
        { label: 'Unassigned', value: -1 },
        ...workspaces.map(ws => ({
          label: store.getWorkspaceName(ws.index),
          description: ws.isCurrent ? '(current)' : undefined,
          value: ws.index,
        })),
      ];

      const picked = await vscode.window.showQuickPick(wsItems, {
        placeHolder: `Assign "${project.name}" to workspace:`,
      });
      if (!picked) { return; }

      await store.update(project.id, { targetWorkspace: picked.value });
      vscode.window.showInformationMessage(
        `Assigned "${project.name}" to ${picked.value >= 0 ? picked.label : 'none'}.`
      );
      refreshAll();
    }],

    ['gwm.openProject', async (arg?: ManagedProject) => {
      let project: ManagedProject | undefined = arg;
      if (arg && arg instanceof ProjectItem) {
        project = (arg as any).project;
      }
      if (!project || !project.id) {
        project = await pickProject(store, 'Select project to open');
      }
      if (!project) { return; }

      await gnome.openInEditor(project.workspaceFile || project.path);
      await store.updateLastOpened(project.id);
      refreshAll();
    }],

    ['gwm.switchToProject', async (arg?: ManagedProject) => {
      let project: ManagedProject | undefined = arg;
      if (arg && arg instanceof ProjectItem) {
        project = (arg as any).project;
      }
      if (!project || !project.id) {
        project = await pickProject(store, 'Select project to switch to');
      }
      if (!project) { return; }

      const names = getWindowMatchNames(project);
      let found = false;
      for (const name of names) {
        found = await gnome.focusWindowByTitle(name);
        if (found) { break; }
      }
      if (!found) {
        const action = await vscode.window.showInformationMessage(
          `"${project.name}" is not open. Open it now?`,
          'Open', 'Cancel',
        );
        if (action === 'Open') {
          await gnome.openInEditor(project.workspaceFile || project.path);
          await store.updateLastOpened(project.id);
        }
      } else {
        await store.updateLastOpened(project.id);
      }
    }],

    ['gwm.removeProject', async (arg?: ManagedProject) => {
      let project: ManagedProject | undefined = arg;
      if (arg && arg instanceof ProjectItem) {
        project = (arg as any).project;
      }
      if (!project || !project.id) {
        project = await pickProject(store, 'Select project to remove');
      }
      if (!project) { return; }

      const confirm = await vscode.window.showWarningMessage(
        `Remove "${project.name}" from workspace manager?`,
        { modal: true }, 'Remove',
      );
      if (confirm !== 'Remove') { return; }
      await store.remove(project.id);
      refreshAll();
    }],

    ['gwm.renameProject', async (arg?: ManagedProject) => {
      let project: ManagedProject | undefined = arg;
      if (arg && arg instanceof ProjectItem) {
        project = (arg as any).project;
      }
      if (!project || !project.id) {
        project = await pickProject(store, 'Select project to rename');
      }
      if (!project) { return; }

      const newName = await vscode.window.showInputBox({
        prompt: `Rename project "${project.name}"`,
        value: project.name,
        validateInput: v => v.trim() ? null : 'Name cannot be empty',
      });
      if (newName === undefined || newName.trim() === project.name) { return; }

      await store.update(project.id, { name: newName.trim() });
      refreshAll();
    }],

    ['gwm.editProject', async (arg?: ManagedProject) => {
      let project: ManagedProject | undefined = arg;
      if (arg && arg instanceof ProjectItem) {
        project = (arg as any).project;
      }
      if (!project || !project.id) {
        project = await pickProject(store, 'Select project to edit');
      }
      if (!project) { return; }

      const name = await vscode.window.showInputBox({
        prompt: 'Project display name',
        value: project.name,
      });
      if (name === undefined) { return; }

      const group = await vscode.window.showInputBox({
        prompt: 'Group (leave empty for none)',
        value: project.group,
      });

      const notes = await vscode.window.showInputBox({
        prompt: 'Notes',
        value: project.notes,
      });

      await store.update(project.id, {
        name: name || project.name,
        group: group || '',
        notes: notes || '',
      });
      refreshAll();
    }],

    ['gwm.togglePin', async (arg?: ManagedProject) => {
      let project: ManagedProject | undefined = arg;
      if (arg && arg instanceof ProjectItem) {
        project = (arg as any).project;
      }
      if (!project || !project.id) {
        project = await pickProject(store, 'Select project to pin/unpin');
      }
      if (!project) { return; }
      await store.togglePin(project.id);
      refreshAll();
    }],

    ['gwm.scanProjects', async () => {
      const config = vscode.workspace.getConfiguration('gnomeWorkspaceManager');
      let dirs = config.get<string[]>('scanDirectories', []);

      if (dirs.length === 0) {
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: true,
          openLabel: 'Select Directories to Scan',
        });
        if (!uris || uris.length === 0) { return; }
        dirs = uris.map(u => u.fsPath);
      }

      const depth = config.get<number>('scanDepth', 2);
      const indicators = config.get<string[]>('projectIndicators', ['.git', 'package.json']);

      await vscode.window.withProgress(
        { location: vscode.ProgressLocation.Notification, title: 'Scanning for projects...' },
        async () => {
          const allFound: string[] = [];
          for (const dir of dirs) {
            const found = await store.scanDirectory(dir, depth, indicators);
            allFound.push(...found);
          }

          if (allFound.length === 0) {
            vscode.window.showInformationMessage('No new projects found.');
            return;
          }

          const items = allFound.map(p => ({
            label: path.basename(p),
            description: p,
            picked: true,
            path: p,
          }));

          const selected = await vscode.window.showQuickPick(items, {
            canPickMany: true,
            placeHolder: `Found ${items.length} projects. Select which to add:`,
          });

          if (selected && selected.length > 0) {
            for (const item of selected) {
              await store.addFromPath(item.path);
            }
            vscode.window.showInformationMessage(`Added ${selected.length} projects.`);
            refreshAll();
          }
        },
      );
    }],

    ['gwm.quickSwitch', async () => {
      const projects = store.getAll();
      if (projects.length === 0) {
        vscode.window.showInformationMessage('No projects managed yet. Add one first.');
        return;
      }

      const openWindows = await gnome.findEditorWindows();

      const items = [...projects]
        .sort((a, b) => (b.lastOpened || 0) - (a.lastOpened || 0))
        .map(p => {
          const names = getWindowMatchNames(p);
          const isOpen = openWindows.some(w => names.some(n => w.title.includes(n)));
          const wsLabel = p.targetWorkspace >= 0
            ? `WS ${p.targetWorkspace + 1}`
            : '';
          return {
            label: `${isOpen ? '$(circle-filled) ' : '$(circle-outline) '}${p.name}`,
            description: [wsLabel, p.group].filter(Boolean).join(' · '),
            detail: p.path,
            project: p,
            isOpen,
          };
        });

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: 'Switch to project...',
        matchOnDescription: true,
        matchOnDetail: true,
      });

      if (!picked) { return; }

      if (picked.isOpen) {
        const names = getWindowMatchNames(picked.project);
        for (const name of names) {
          const found = await gnome.focusWindowByTitle(name);
          if (found) { break; }
        }
      } else {
        await gnome.openInEditor(picked.project.workspaceFile || picked.project.path);
      }
      await store.updateLastOpened(picked.project.id);
    }],

    ['gwm.moveToWorkspace', async (arg?: ManagedProject) => {
      let project: ManagedProject | undefined = arg;
      if (arg && arg instanceof ProjectItem) {
        project = (arg as any).project;
      }
      if (!project || !project.id) {
        project = await pickProject(store, 'Select project to move');
      }
      if (!project) { return; }

      const workspaces = await gnome.getWorkspaces();
      const wsItems = [
        { label: 'Unassigned', value: -1 },
        ...workspaces.map(ws => ({
          label: store.getWorkspaceName(ws.index),
          description: ws.isCurrent ? '(current)' : undefined,
          value: ws.index,
        })),
      ];

      const picked = await vscode.window.showQuickPick(wsItems, {
        placeHolder: `Move "${project.name}" to workspace:`,
      });
      if (!picked) { return; }

      await store.update(project.id, { targetWorkspace: picked.value });
      refreshAll();
    }],

    ['gwm.renameWorkspace', async (arg?: any) => {
      let wsIndex: number | undefined;

      if (arg instanceof WorkspaceItem) {
        wsIndex = arg.workspaceIndex;
      }

      if (wsIndex === undefined) {
        const workspaces = await gnome.getWorkspaces();
        const items = workspaces.map(ws => ({
          label: store.getWorkspaceName(ws.index),
          description: ws.isCurrent ? '(current)' : undefined,
          value: ws.index,
        }));
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: 'Select workspace to rename',
        });
        if (!picked) { return; }
        wsIndex = picked.value;
      }

      const currentName = store.getWorkspaceName(wsIndex);
      const newName = await vscode.window.showInputBox({
        prompt: `Rename workspace ${wsIndex + 1}`,
        value: currentName,
        placeHolder: `Workspace ${wsIndex + 1}`,
      });
      if (newName === undefined) { return; }

      await store.setWorkspaceName(wsIndex, newName);
      refreshAll();
    }],

    ['gwm.openAll', async () => {
      const projects = store.getAll();
      if (projects.length === 0) {
        vscode.window.showInformationMessage('No projects managed yet.');
        return;
      }
      const openWindows = await gnome.findEditorWindows();
      let opened = 0;
      for (const project of projects) {
        const names = getWindowMatchNames(project);
        const alreadyOpen = openWindows.some(w => names.some(n => w.title.includes(n)));
        if (!alreadyOpen) {
          await gnome.openInEditor(project.workspaceFile || project.path);
          await store.updateLastOpened(project.id);
          opened++;
        }
      }
      vscode.window.showInformationMessage(
        opened > 0
          ? `Opened ${opened} project${opened === 1 ? '' : 's'}.`
          : 'All projects are already open.'
      );
      refreshAll();
    }],

    ['gwm.closeAll', async () => {
      const projects = store.getAll();
      if (projects.length === 0) {
        vscode.window.showInformationMessage('No projects managed yet.');
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Close all open project windows? (${projects.length} managed)`,
        { modal: true }, 'Close All',
      );
      if (confirm !== 'Close All') { return; }

      let closed = 0;
      for (const project of projects) {
        const names = getWindowMatchNames(project);
        for (const name of names) {
          const success = await gnome.closeWindowByTitle(name);
          if (success) { closed++; break; }
        }
      }
      vscode.window.showInformationMessage(`Closed ${closed} project window${closed === 1 ? '' : 's'}.`);
      setTimeout(() => refreshAll(), 1000);
    }],

    ['gwm.closeOthers', async (arg?: ManagedProject) => {
      let project: ManagedProject | undefined = arg;
      if (arg && arg instanceof ProjectItem) {
        project = (arg as any).project;
      }
      if (!project || !project.id) {
        project = await pickProject(store, 'Keep this project open, close others');
      }
      if (!project) { return; }

      const others = store.getAll().filter(p => p.id !== project!.id);
      let closed = 0;
      for (const other of others) {
        const names = getWindowMatchNames(other);
        for (const name of names) {
          const success = await gnome.closeWindowByTitle(name);
          if (success) { closed++; break; }
        }
      }
      vscode.window.showInformationMessage(
        `Closed ${closed} other project window${closed === 1 ? '' : 's'}. "${project.name}" kept open.`
      );
      setTimeout(() => refreshAll(), 1000);
    }],

    ['gwm.openWorkspaceProjects', async (arg?: any) => {
      let wsIndex: number | undefined;
      if (arg instanceof WorkspaceItem) {
        wsIndex = arg.workspaceIndex;
      }
      if (wsIndex === undefined) {
        const workspaces = await gnome.getWorkspaces();
        const items = workspaces.map(ws => ({
          label: store.getWorkspaceName(ws.index),
          description: ws.isCurrent ? '(current)' : undefined,
          value: ws.index,
        }));
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: 'Open all projects in which workspace?',
        });
        if (!picked) { return; }
        wsIndex = picked.value;
      }

      const projects = store.getByWorkspace(wsIndex);
      if (projects.length === 0) {
        vscode.window.showInformationMessage('No projects assigned to this workspace.');
        return;
      }
      const openWindows = await gnome.findEditorWindows();
      let opened = 0;
      for (const project of projects) {
        const names = getWindowMatchNames(project);
        const alreadyOpen = openWindows.some(w => names.some(n => w.title.includes(n)));
        if (!alreadyOpen) {
          await gnome.openInEditor(project.workspaceFile || project.path);
          await store.updateLastOpened(project.id);
          opened++;
        }
      }
      vscode.window.showInformationMessage(
        opened > 0
          ? `Opened ${opened} project${opened === 1 ? '' : 's'} in ${store.getWorkspaceName(wsIndex)}.`
          : `All projects in ${store.getWorkspaceName(wsIndex)} are already open.`
      );
      refreshAll();
    }],

    ['gwm.closeWorkspaceProjects', async (arg?: any) => {
      let wsIndex: number | undefined;
      if (arg instanceof WorkspaceItem) {
        wsIndex = arg.workspaceIndex;
      }
      if (wsIndex === undefined) {
        const workspaces = await gnome.getWorkspaces();
        const items = workspaces.map(ws => ({
          label: store.getWorkspaceName(ws.index),
          description: ws.isCurrent ? '(current)' : undefined,
          value: ws.index,
        }));
        const picked = await vscode.window.showQuickPick(items, {
          placeHolder: 'Close all projects in which workspace?',
        });
        if (!picked) { return; }
        wsIndex = picked.value;
      }

      const projects = store.getByWorkspace(wsIndex);
      if (projects.length === 0) {
        vscode.window.showInformationMessage('No projects assigned to this workspace.');
        return;
      }

      let closed = 0;
      for (const project of projects) {
        const names = getWindowMatchNames(project);
        for (const name of names) {
          const success = await gnome.closeWindowByTitle(name);
          if (success) { closed++; break; }
        }
      }
      vscode.window.showInformationMessage(
        `Closed ${closed} project window${closed === 1 ? '' : 's'} in ${store.getWorkspaceName(wsIndex)}.`
      );
      setTimeout(() => refreshAll(), 1000);
    }],

    ['gwm.toggleAutoOpen', async (arg?: ManagedProject) => {
      let project: ManagedProject | undefined = arg;
      if (arg && arg instanceof ProjectItem) {
        project = (arg as any).project;
      }
      if (!project || !project.id) {
        project = await pickProject(store, 'Toggle auto-open for project');
      }
      if (!project) { return; }

      const newValue = !project.autoOpen;
      await store.update(project.id, { autoOpen: newValue });
      vscode.window.showInformationMessage(
        `"${project.name}" will ${newValue ? 'auto-open' : 'no longer auto-open'} on startup.`
      );
      refreshAll();
    }],

    ['gwm.exportConfig', () => store.exportToFile()],
    ['gwm.importConfig', () => store.importFromFile()],

    ['gwm.refreshViews', () => refreshAll()],

    ['gwm.openProjectTerminal', async (arg?: ManagedProject) => {
      let project: ManagedProject | undefined = arg;
      if (arg && arg instanceof ProjectItem) {
        project = (arg as any).project;
      }
      if (!project || !project.id) {
        project = await pickProject(store, 'Select project for terminal');
      }
      if (!project) { return; }

      const terminal = vscode.window.createTerminal({
        name: project.name,
        cwd: project.path,
      });
      terminal.show();
    }],

    ['gwm.checkHealth', async () => {
      const { valid, missing } = store.checkHealth();
      if (missing.length === 0) {
        vscode.window.showInformationMessage(`All ${valid.length} project paths are valid.`);
        return;
      }

      const items = missing.map(p => ({
        label: `$(warning) ${p.name}`,
        description: p.path,
        detail: 'Path not found',
        project: p,
      }));

      const action = await vscode.window.showWarningMessage(
        `${missing.length} project(s) have missing paths.`,
        'Show Details', 'Remove Missing', 'Dismiss',
      );

      if (action === 'Show Details') {
        const selected = await vscode.window.showQuickPick(items, {
          canPickMany: true,
          placeHolder: 'Select projects to remove:',
        });
        if (selected) {
          for (const item of selected) {
            await store.remove(item.project.id);
          }
          refreshAll();
        }
      } else if (action === 'Remove Missing') {
        for (const p of missing) {
          await store.remove(p.id);
        }
        vscode.window.showInformationMessage(`Removed ${missing.length} projects with missing paths.`);
        refreshAll();
      }
    }],
  ];

  for (const [id, handler] of commands) {
    context.subscriptions.push(vscode.commands.registerCommand(id, handler));
  }

  // ── Helpers ──

  function refreshAll(): void {
    workspaceTree.refreshWithWindows();
    projectTree.refreshWithWindows();
    statusBar.update();
  }

  // Periodically refresh window state
  const refreshInterval = setInterval(() => {
    workspaceTree.refreshWithWindows();
    projectTree.refreshWithWindows();
  }, 30_000);
  context.subscriptions.push({ dispose: () => clearInterval(refreshInterval) });

  outputChannel.appendLine('GNOME Workspace Manager activated.');
}

async function autoPlaceCurrentProject(store: ProjectStore, gnome: GnomeHelper): Promise<void> {
  const folder = getCurrentWorkspaceFolder();
  if (!folder) { return; }

  const project = store.getByPath(folder);
  if (!project || project.targetWorkspace < 0) { return; }

  const names = getWindowMatchNames(project);
  let success = false;
  for (const name of names) {
    success = await gnome.moveWindowByTitle(name, project.targetWorkspace);
    if (success) { break; }
  }
  if (success) {
    outputChannel.appendLine(`Auto-placed "${project.name}" to workspace ${project.targetWorkspace + 1}.`);
  }
}

function getCurrentWorkspaceFolder(): string | undefined {
  const folders = vscode.workspace.workspaceFolders;
  if (folders && folders.length > 0) {
    return folders[0].uri.fsPath;
  }
  return undefined;
}

async function pickProject(
  store: ProjectStore,
  placeholder: string,
): Promise<ManagedProject | undefined> {
  const projects = store.getAll();
  if (projects.length === 0) {
    vscode.window.showInformationMessage('No projects managed yet.');
    return undefined;
  }

  const items = projects.map(p => ({
    label: p.pinned ? `$(pinned) ${p.name}` : p.name,
    description: p.targetWorkspace >= 0
      ? `WS ${p.targetWorkspace + 1}`
      : 'Unassigned',
    detail: p.path,
    project: p,
  }));

  const picked = await vscode.window.showQuickPick(items, {
    placeHolder: placeholder,
    matchOnDescription: true,
    matchOnDetail: true,
  });

  return picked?.project;
}

export function deactivate() {
  outputChannel?.appendLine('GNOME Workspace Manager deactivated.');
}
