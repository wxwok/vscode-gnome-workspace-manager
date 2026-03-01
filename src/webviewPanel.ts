import * as vscode from 'vscode';
import { ProjectStore } from './projectStore';
import { GnomeHelper } from './gnomeHelper';
import { ManagedProject, PROJECT_COLORS, WorkspaceInfo, WindowInfo } from './types';

export class ManagementPanel {
  public static currentPanel: ManagementPanel | undefined;
  private readonly panel: vscode.WebviewPanel;
  private disposables: vscode.Disposable[] = [];

  private constructor(
    panel: vscode.WebviewPanel,
    private store: ProjectStore,
    private gnome: GnomeHelper,
  ) {
    this.panel = panel;
    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);
    this.panel.webview.onDidReceiveMessage(
      msg => this.handleMessage(msg),
      null,
      this.disposables,
    );
    this.store.onDidChange(() => this.sendUpdate(), undefined, this.disposables);
    this.panel.webview.html = this.getHtml();
    this.sendUpdate();
  }

  static show(
    extensionUri: vscode.Uri,
    store: ProjectStore,
    gnome: GnomeHelper,
  ): ManagementPanel {
    if (ManagementPanel.currentPanel) {
      ManagementPanel.currentPanel.panel.reveal(vscode.ViewColumn.One);
      return ManagementPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'gwm.management',
      'Workspace Manager',
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
      },
    );

    ManagementPanel.currentPanel = new ManagementPanel(panel, store, gnome);
    return ManagementPanel.currentPanel;
  }

  private dispose(): void {
    ManagementPanel.currentPanel = undefined;
    this.panel.dispose();
    for (const d of this.disposables) { d.dispose(); }
    this.disposables = [];
  }

  private async handleMessage(msg: any): Promise<void> {
    switch (msg.command) {
      case 'ready':
        await this.sendUpdate();
        break;
      case 'addProject': {
        const uris = await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: true,
          openLabel: 'Add Project',
        });
        if (uris) {
          for (const uri of uris) {
            await this.store.addFromPath(uri.fsPath, msg.workspace ?? -1);
          }
        }
        break;
      }
      case 'removeProject':
        await this.store.remove(msg.id);
        break;
      case 'updateProject':
        await this.store.update(msg.id, msg.updates);
        break;
      case 'assignWorkspace':
        await this.store.update(msg.id, { targetWorkspace: msg.workspace });
        break;
      case 'togglePin':
        await this.store.togglePin(msg.id);
        break;
      case 'openProject':
        await this.gnome.openInEditor(msg.path);
        await this.store.updateLastOpened(msg.id);
        break;
      case 'switchToProject': {
        const folderName = msg.path.split('/').pop() || '';
        await this.gnome.focusWindowByTitle(folderName);
        break;
      }
      case 'placeAll':
        await this.placeAll();
        break;
      case 'placeProject': {
        const project = this.store.getById(msg.id);
        if (project && project.targetWorkspace >= 0) {
          const folderName = project.path.split('/').pop() || '';
          await this.gnome.moveWindowByTitle(folderName, project.targetWorkspace);
        }
        break;
      }
      case 'renameWorkspace':
        await this.store.setWorkspaceName(msg.index, msg.name);
        break;
      case 'exportConfig':
        await this.store.exportToFile();
        break;
      case 'importConfig':
        await this.store.importFromFile();
        break;
      case 'refreshWindows':
        await this.sendUpdate();
        break;
    }
  }

  private async placeAll(): Promise<void> {
    const projects = this.store.getAll().filter(p => p.targetWorkspace >= 0);
    let placed = 0;
    for (const project of projects) {
      const folderName = project.path.split('/').pop() || '';
      const success = await this.gnome.moveWindowByTitle(folderName, project.targetWorkspace);
      if (success) { placed++; }
    }
    vscode.window.showInformationMessage(`Placed ${placed}/${projects.length} project windows.`);
    await this.sendUpdate();
  }

  private async sendUpdate(): Promise<void> {
    const [workspaces, windows] = await Promise.all([
      this.gnome.getWorkspaces(),
      this.gnome.findEditorWindows(),
    ]);

    this.panel.webview.postMessage({
      command: 'update',
      projects: this.store.getAll(),
      workspaces,
      windows,
      colors: PROJECT_COLORS,
    });
  }

  private getHtml(): string {
    return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline';">
<title>Workspace Manager</title>
<style>
  :root {
    --card-bg: var(--vscode-editor-background);
    --card-border: var(--vscode-widget-border, var(--vscode-editorGroup-border));
    --hover-bg: var(--vscode-list-hoverBackground);
    --accent: var(--vscode-focusBorder);
    --badge-bg: var(--vscode-badge-background);
    --badge-fg: var(--vscode-badge-foreground);
    --danger: var(--vscode-errorForeground);
    --radius: 6px;
    --gap: 12px;
  }

  * { box-sizing: border-box; margin: 0; padding: 0; }

  body {
    font-family: var(--vscode-font-family);
    font-size: var(--vscode-font-size);
    color: var(--vscode-foreground);
    background: var(--vscode-editor-background);
    padding: 16px;
    line-height: 1.5;
  }

  /* ── Header ── */
  .header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 20px;
    padding-bottom: 12px;
    border-bottom: 1px solid var(--card-border);
  }
  .header h1 {
    font-size: 1.4em;
    font-weight: 600;
    display: flex;
    align-items: center;
    gap: 8px;
  }
  .header-actions {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  /* ── Buttons ── */
  button {
    background: var(--vscode-button-background);
    color: var(--vscode-button-foreground);
    border: none;
    padding: 6px 14px;
    border-radius: var(--radius);
    cursor: pointer;
    font-size: 0.85em;
    font-family: inherit;
    display: inline-flex;
    align-items: center;
    gap: 6px;
    transition: opacity 0.15s;
  }
  button:hover { opacity: 0.85; }
  button.secondary {
    background: var(--vscode-button-secondaryBackground);
    color: var(--vscode-button-secondaryForeground);
  }
  button.danger {
    background: transparent;
    color: var(--danger);
    padding: 4px 8px;
  }
  button.icon-btn {
    background: transparent;
    color: var(--vscode-foreground);
    padding: 4px 6px;
    font-size: 1em;
    opacity: 0.6;
  }
  button.icon-btn:hover { opacity: 1; }

  /* ── Tabs ── */
  .tabs {
    display: flex;
    gap: 0;
    margin-bottom: 16px;
    border-bottom: 1px solid var(--card-border);
  }
  .tab {
    padding: 8px 18px;
    cursor: pointer;
    border-bottom: 2px solid transparent;
    color: var(--vscode-foreground);
    opacity: 0.7;
    font-size: 0.9em;
    background: none;
    border-radius: 0;
  }
  .tab:hover { opacity: 1; }
  .tab.active {
    opacity: 1;
    border-bottom-color: var(--accent);
    color: var(--accent);
  }

  .tab-content { display: none; }
  .tab-content.active { display: block; }

  /* ── Workspace grid ── */
  .workspace-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(280px, 1fr));
    gap: var(--gap);
    margin-bottom: 20px;
  }
  .workspace-card {
    background: var(--vscode-sideBar-background, var(--card-bg));
    border: 1px solid var(--card-border);
    border-radius: var(--radius);
    padding: 14px;
    min-height: 120px;
    transition: border-color 0.15s;
  }
  .workspace-card.current {
    border-color: var(--accent);
    border-width: 2px;
  }
  .workspace-card-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 10px;
  }
  .workspace-card-title {
    font-weight: 600;
    font-size: 0.95em;
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .workspace-card-title .badge {
    background: var(--badge-bg);
    color: var(--badge-fg);
    font-size: 0.75em;
    padding: 1px 7px;
    border-radius: 10px;
    font-weight: normal;
  }
  .workspace-name-input {
    background: transparent;
    border: none;
    border-bottom: 1px solid var(--card-border);
    color: var(--vscode-foreground);
    font-size: 0.95em;
    font-weight: 600;
    font-family: inherit;
    padding: 2px 4px;
    width: 140px;
  }
  .workspace-name-input:focus {
    outline: none;
    border-bottom-color: var(--accent);
  }

  /* ── Project cards inside workspace ── */
  .project-chip {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 6px 10px;
    border-radius: 4px;
    margin-bottom: 4px;
    background: var(--vscode-editor-background);
    border: 1px solid transparent;
    font-size: 0.85em;
    cursor: default;
  }
  .project-chip:hover {
    background: var(--hover-bg);
  }
  .project-chip .color-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .project-chip .name {
    flex: 1;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .project-chip .status-dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    flex-shrink: 0;
  }
  .project-chip .status-dot.open { background: #2ecc71; }
  .project-chip .status-dot.closed { background: var(--vscode-descriptionForeground); opacity: 0.3; }
  .project-chip .actions {
    display: flex;
    gap: 2px;
    opacity: 0;
    transition: opacity 0.15s;
  }
  .project-chip:hover .actions { opacity: 1; }

  .workspace-add-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    padding: 6px;
    margin-top: 6px;
    border: 1px dashed var(--card-border);
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.8em;
    color: var(--vscode-descriptionForeground);
    background: none;
    width: 100%;
    transition: all 0.15s;
  }
  .workspace-add-btn:hover {
    border-color: var(--accent);
    color: var(--accent);
  }

  /* ── Project table ── */
  .project-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.88em;
  }
  .project-table th {
    text-align: left;
    padding: 8px 12px;
    border-bottom: 2px solid var(--card-border);
    font-weight: 600;
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
    text-transform: uppercase;
    letter-spacing: 0.5px;
  }
  .project-table td {
    padding: 8px 12px;
    border-bottom: 1px solid var(--card-border);
    vertical-align: middle;
  }
  .project-table tr:hover td {
    background: var(--hover-bg);
  }
  .project-table .path {
    color: var(--vscode-descriptionForeground);
    font-size: 0.85em;
    max-width: 300px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  select {
    background: var(--vscode-dropdown-background);
    color: var(--vscode-dropdown-foreground);
    border: 1px solid var(--vscode-dropdown-border);
    padding: 4px 8px;
    border-radius: 4px;
    font-family: inherit;
    font-size: 0.9em;
  }

  input[type="text"] {
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--card-border));
    padding: 4px 8px;
    border-radius: 4px;
    font-family: inherit;
    font-size: 0.9em;
  }
  input[type="text"]:focus {
    outline: none;
    border-color: var(--accent);
  }

  /* ── Stats bar ── */
  .stats-bar {
    display: flex;
    gap: 20px;
    margin-bottom: 16px;
    flex-wrap: wrap;
  }
  .stat {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
  }
  .stat .value {
    font-weight: 600;
    color: var(--vscode-foreground);
    font-size: 1.2em;
  }

  /* ── Empty state ── */
  .empty-state {
    text-align: center;
    padding: 40px 20px;
    color: var(--vscode-descriptionForeground);
  }
  .empty-state p { margin-bottom: 12px; }

  /* ── Notes textarea ── */
  textarea {
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--card-border));
    padding: 6px 8px;
    border-radius: 4px;
    font-family: inherit;
    font-size: 0.85em;
    resize: vertical;
    width: 100%;
    min-height: 50px;
  }

  /* ── Edit modal overlay ── */
  .modal-overlay {
    display: none;
    position: fixed;
    top: 0; left: 0; right: 0; bottom: 0;
    background: rgba(0,0,0,0.5);
    z-index: 100;
    align-items: center;
    justify-content: center;
  }
  .modal-overlay.active { display: flex; }
  .modal {
    background: var(--vscode-editor-background);
    border: 1px solid var(--card-border);
    border-radius: 8px;
    padding: 24px;
    min-width: 420px;
    max-width: 90vw;
    box-shadow: 0 8px 32px rgba(0,0,0,0.3);
  }
  .modal h2 {
    margin-bottom: 16px;
    font-size: 1.1em;
  }
  .modal .field {
    margin-bottom: 12px;
  }
  .modal .field label {
    display: block;
    margin-bottom: 4px;
    font-size: 0.85em;
    color: var(--vscode-descriptionForeground);
  }
  .modal .field input[type="text"],
  .modal .field select,
  .modal .field textarea {
    width: 100%;
  }
  .modal-actions {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    margin-top: 16px;
  }

  .color-picker {
    display: flex;
    gap: 6px;
    flex-wrap: wrap;
  }
  .color-swatch {
    width: 24px;
    height: 24px;
    border-radius: 50%;
    cursor: pointer;
    border: 2px solid transparent;
    transition: transform 0.15s;
  }
  .color-swatch:hover { transform: scale(1.15); }
  .color-swatch.selected { border-color: var(--vscode-foreground); }
  .color-swatch.none {
    background: var(--vscode-editor-background);
    border: 2px dashed var(--card-border);
  }
</style>
</head>
<body>

<div class="header">
  <h1>
    <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <rect x="2" y="3" width="8" height="8" rx="1"/>
      <rect x="14" y="3" width="8" height="8" rx="1"/>
      <rect x="2" y="13" width="8" height="8" rx="1"/>
      <rect x="14" y="13" width="8" height="8" rx="1"/>
    </svg>
    Workspace Manager
  </h1>
  <div class="header-actions">
    <button onclick="send('placeAll')" title="Move all project windows to their assigned workspaces">
      ⬡ Place All
    </button>
    <button onclick="send('refreshWindows')" class="secondary" title="Refresh window status">
      ↻ Refresh
    </button>
    <button onclick="send('exportConfig')" class="secondary">Export</button>
    <button onclick="send('importConfig')" class="secondary">Import</button>
  </div>
</div>

<div class="stats-bar" id="statsBar"></div>

<div class="tabs">
  <button class="tab active" data-tab="workspaces">Workspaces</button>
  <button class="tab" data-tab="projects">All Projects</button>
</div>

<div class="tab-content active" id="tab-workspaces">
  <div class="workspace-grid" id="workspaceGrid"></div>
</div>

<div class="tab-content" id="tab-projects">
  <div id="projectsTable"></div>
</div>

<!-- Edit project modal -->
<div class="modal-overlay" id="editModal">
  <div class="modal">
    <h2>Edit Project</h2>
    <input type="hidden" id="editId">
    <div class="field">
      <label>Name</label>
      <input type="text" id="editName">
    </div>
    <div class="field">
      <label>Group</label>
      <input type="text" id="editGroup" placeholder="e.g. work, personal, oss">
    </div>
    <div class="field">
      <label>Notes</label>
      <textarea id="editNotes" placeholder="Quick notes about this project..."></textarea>
    </div>
    <div class="field">
      <label>Color</label>
      <div class="color-picker" id="editColorPicker"></div>
    </div>
    <div class="field" style="display:flex; align-items:center; gap:8px;">
      <input type="checkbox" id="editAutoOpen">
      <label for="editAutoOpen" style="margin:0;">Auto-open on startup</label>
    </div>
    <div class="modal-actions">
      <button class="secondary" onclick="closeEditModal()">Cancel</button>
      <button onclick="saveEdit()">Save</button>
    </div>
  </div>
</div>

<script>
const vscode = acquireVsCodeApi();
let state = { projects: [], workspaces: [], windows: [], colors: [] };

function send(command, data) {
  vscode.postMessage({ command, ...data });
}

// Tab switching
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.tab-content').forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('tab-' + tab.dataset.tab).classList.add('active');
  });
});

window.addEventListener('message', event => {
  const msg = event.data;
  if (msg.command === 'update') {
    state = msg;
    render();
  }
});

function isOpen(project) {
  const folderName = project.path.split('/').pop() || '';
  return state.windows.some(w => w.title.includes(folderName));
}

function render() {
  renderStats();
  renderWorkspaceGrid();
  renderProjectsTable();
}

function renderStats() {
  const total = state.projects.length;
  const assigned = state.projects.filter(p => p.targetWorkspace >= 0).length;
  const open = state.projects.filter(p => isOpen(p)).length;

  document.getElementById('statsBar').innerHTML = [
    stat('Total', total),
    stat('Assigned', assigned),
    stat('Open', open),
    stat('Workspaces', state.workspaces.length),
  ].join('');
}

function stat(label, value) {
  return '<div class="stat"><span class="value">' + value + '</span>' + label + '</div>';
}

function renderWorkspaceGrid() {
  const grid = document.getElementById('workspaceGrid');
  if (state.workspaces.length === 0) {
    grid.innerHTML = '<div class="empty-state"><p>No workspace information available.</p><p>Make sure wmctrl or gdbus is installed.</p></div>';
    return;
  }

  let html = '';
  const unassigned = state.projects.filter(p => p.targetWorkspace < 0);

  for (const ws of state.workspaces) {
    const projects = state.projects.filter(p => p.targetWorkspace === ws.index);
    html += '<div class="workspace-card' + (ws.isCurrent ? ' current' : '') + '">';
    html += '<div class="workspace-card-header">';
    html += '<div class="workspace-card-title">';
    html += '<input class="workspace-name-input" value="' + escHtml(ws.name) + '" data-ws-index="' + ws.index + '" onchange="renameWorkspace(this)" />';
    html += '<span class="badge">' + projects.length + '</span>';
    if (ws.isCurrent) html += '<span class="badge" style="background:var(--accent)">current</span>';
    html += '</div></div>';

    for (const p of projects) {
      html += renderProjectChip(p);
    }

    html += '<button class="workspace-add-btn" onclick="send(\'addProject\', {workspace: ' + ws.index + '})">+ Add project</button>';
    html += '</div>';
  }

  if (unassigned.length > 0) {
    html += '<div class="workspace-card">';
    html += '<div class="workspace-card-header"><div class="workspace-card-title">Unassigned <span class="badge">' + unassigned.length + '</span></div></div>';
    for (const p of unassigned) {
      html += renderProjectChip(p);
    }
    html += '</div>';
  }

  grid.innerHTML = html;
}

function renderProjectChip(p) {
  const open = isOpen(p);
  let html = '<div class="project-chip">';
  if (p.color) {
    const colorObj = state.colors.find(c => c.id === p.color);
    html += '<span class="color-dot" style="background:' + (colorObj ? colorObj.hex : p.color) + '"></span>';
  }
  html += '<span class="status-dot ' + (open ? 'open' : 'closed') + '" title="' + (open ? 'Window open' : 'Not open') + '"></span>';
  html += '<span class="name" title="' + escHtml(p.path) + '">' + escHtml(p.name) + '</span>';
  html += '<span class="actions">';
  html += '<button class="icon-btn" onclick="send(\'openProject\', {id:\'' + p.id + '\', path:\'' + escJs(p.path) + '\'})" title="Open">▶</button>';
  html += '<button class="icon-btn" onclick="send(\'switchToProject\', {id:\'' + p.id + '\', path:\'' + escJs(p.path) + '\'})" title="Switch to window">⇄</button>';
  html += '<button class="icon-btn" onclick="send(\'placeProject\', {id:\'' + p.id + '\'})" title="Place to workspace">⬡</button>';
  html += '<button class="icon-btn" onclick="openEditModal(\'' + p.id + '\')" title="Edit">✎</button>';
  html += '<button class="icon-btn danger" onclick="send(\'removeProject\', {id:\'' + p.id + '\'})" title="Remove">✕</button>';
  html += '</span></div>';
  return html;
}

function renderProjectsTable() {
  const container = document.getElementById('projectsTable');
  const projects = state.projects;

  if (projects.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>No projects added yet.</p><p><button onclick="send(\'addProject\', {workspace:-1})">+ Add a project folder</button></p></div>';
    return;
  }

  let html = '<table class="project-table">';
  html += '<thead><tr><th>Name</th><th>Path</th><th>Workspace</th><th>Group</th><th>Status</th><th>Actions</th></tr></thead>';
  html += '<tbody>';

  const sorted = [...projects].sort((a, b) => {
    if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
    return a.name.localeCompare(b.name);
  });

  for (const p of sorted) {
    const open = isOpen(p);
    html += '<tr>';
    html += '<td>' + (p.pinned ? '📌 ' : '') + escHtml(p.name) + '</td>';
    html += '<td class="path" title="' + escHtml(p.path) + '">' + escHtml(p.path) + '</td>';
    html += '<td><select onchange="send(\'assignWorkspace\', {id:\'' + p.id + '\', workspace: parseInt(this.value)})">';
    html += '<option value="-1"' + (p.targetWorkspace < 0 ? ' selected' : '') + '>—</option>';
    for (const ws of state.workspaces) {
      html += '<option value="' + ws.index + '"' + (p.targetWorkspace === ws.index ? ' selected' : '') + '>' + escHtml(ws.name) + '</option>';
    }
    html += '</select></td>';
    html += '<td>' + escHtml(p.group || '—') + '</td>';
    html += '<td><span class="status-dot ' + (open ? 'open' : 'closed') + '" style="display:inline-block"></span> ' + (open ? 'Open' : 'Closed') + '</td>';
    html += '<td>';
    html += '<button class="icon-btn" onclick="send(\'openProject\', {id:\'' + p.id + '\', path:\'' + escJs(p.path) + '\'})" title="Open">▶</button>';
    html += '<button class="icon-btn" onclick="send(\'switchToProject\', {id:\'' + p.id + '\', path:\'' + escJs(p.path) + '\'})" title="Switch">⇄</button>';
    html += '<button class="icon-btn" onclick="send(\'placeProject\', {id:\'' + p.id + '\'})" title="Place">⬡</button>';
    html += '<button class="icon-btn" onclick="openEditModal(\'' + p.id + '\')" title="Edit">✎</button>';
    html += '<button class="icon-btn" onclick="send(\'togglePin\', {id:\'' + p.id + '\'})" title="Pin">' + (p.pinned ? '📌' : '📍') + '</button>';
    html += '<button class="icon-btn danger" onclick="send(\'removeProject\', {id:\'' + p.id + '\'})" title="Remove">✕</button>';
    html += '</td></tr>';
  }

  html += '</tbody></table>';
  container.innerHTML = html;
}

function renameWorkspace(input) {
  send('renameWorkspace', { index: parseInt(input.dataset.wsIndex), name: input.value });
}

// ── Edit modal ──
function openEditModal(id) {
  const project = state.projects.find(p => p.id === id);
  if (!project) return;
  document.getElementById('editId').value = project.id;
  document.getElementById('editName').value = project.name;
  document.getElementById('editGroup').value = project.group || '';
  document.getElementById('editNotes').value = project.notes || '';
  document.getElementById('editAutoOpen').checked = project.autoOpen || false;

  const picker = document.getElementById('editColorPicker');
  picker.innerHTML = state.colors.map(c =>
    '<div class="color-swatch' + (project.color === c.id ? ' selected' : '') + ((c.id === 'none') ? ' none' : '') + '" ' +
    'style="' + (c.hex ? 'background:' + c.hex : '') + '" ' +
    'data-color="' + c.id + '" ' +
    'onclick="selectColor(this)" title="' + c.label + '"></div>'
  ).join('');

  document.getElementById('editModal').classList.add('active');
}

function closeEditModal() {
  document.getElementById('editModal').classList.remove('active');
}

function selectColor(el) {
  document.querySelectorAll('#editColorPicker .color-swatch').forEach(s => s.classList.remove('selected'));
  el.classList.add('selected');
}

function saveEdit() {
  const id = document.getElementById('editId').value;
  const selected = document.querySelector('#editColorPicker .color-swatch.selected');
  const color = selected ? selected.dataset.color : 'none';
  send('updateProject', {
    id,
    updates: {
      name: document.getElementById('editName').value,
      group: document.getElementById('editGroup').value,
      notes: document.getElementById('editNotes').value,
      color: color === 'none' ? '' : color,
      autoOpen: document.getElementById('editAutoOpen').checked,
    }
  });
  closeEditModal();
}

function escHtml(s) {
  const d = document.createElement('div');
  d.textContent = s;
  return d.innerHTML;
}

function escJs(s) {
  return s.replace(/\\\\/g, '\\\\\\\\').replace(/'/g, "\\\\'");
}

// Initial data request
send('ready');
</script>
</body>
</html>`;
  }
}
