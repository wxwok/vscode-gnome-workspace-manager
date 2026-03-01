import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import * as vscode from 'vscode';
import { DisplayMode, WindowInfo, WorkspaceInfo } from './types';

const execAsync = promisify(exec);

export class GnomeHelper {
  private _displayMode: DisplayMode = 'unknown';
  private _hasWmctrl = false;
  private _hasXdotool = false;
  private _hasGdbus = false;
  private _initialized = false;
  private _outputChannel: vscode.OutputChannel;

  constructor(outputChannel: vscode.OutputChannel) {
    this._outputChannel = outputChannel;
  }

  get displayMode(): DisplayMode {
    return this._displayMode;
  }

  async init(): Promise<void> {
    if (this._initialized) { return; }

    await Promise.all([
      this.checkTool('wmctrl').then(v => { this._hasWmctrl = v; }),
      this.checkTool('xdotool').then(v => { this._hasXdotool = v; }),
      this.checkTool('gdbus').then(v => { this._hasGdbus = v; }),
    ]);

    const sessionType = process.env.XDG_SESSION_TYPE;
    if (sessionType === 'x11') {
      this._displayMode = 'x11';
    } else if (sessionType === 'wayland') {
      this._displayMode = 'wayland';
    } else if (this._hasWmctrl) {
      this._displayMode = 'x11';
    } else {
      this._displayMode = 'unknown';
    }

    this.log(`Display mode: ${this._displayMode}, wmctrl: ${this._hasWmctrl}, xdotool: ${this._hasXdotool}, gdbus: ${this._hasGdbus}`);
    this._initialized = true;
  }

  private async checkTool(name: string): Promise<boolean> {
    try {
      await execAsync(`which ${name}`);
      return true;
    } catch {
      return false;
    }
  }

  private log(msg: string): void {
    this._outputChannel.appendLine(`[GnomeHelper] ${msg}`);
  }

  async ensureTools(): Promise<boolean> {
    if (this._displayMode === 'x11' && !this._hasWmctrl) {
      const action = await vscode.window.showWarningMessage(
        'wmctrl is required for X11 window management. Install it?',
        'Install (apt)', 'Manual'
      );
      if (action === 'Install (apt)') {
        const term = vscode.window.createTerminal('Install wmctrl');
        term.show();
        term.sendText('sudo apt install -y wmctrl xdotool && echo "Done! You can close this terminal."');
        return false;
      }
      if (action === 'Manual') {
        vscode.window.showInformationMessage('Install wmctrl: sudo apt install wmctrl xdotool');
      }
      return false;
    }
    if (this._displayMode === 'wayland' && !this._hasGdbus) {
      vscode.window.showErrorMessage('gdbus is required for Wayland window management but was not found.');
      return false;
    }
    return true;
  }

  // ── Window listing ──

  async getWindows(): Promise<WindowInfo[]> {
    try {
      if (this._hasWmctrl) {
        return this.getWindowsWmctrl();
      }
      if (this._displayMode === 'wayland' && this._hasGdbus) {
        return this.getWindowsGdbus();
      }
    } catch (e) {
      this.log(`Error getting windows: ${e}`);
    }
    return [];
  }

  private async getWindowsWmctrl(): Promise<WindowInfo[]> {
    const { stdout } = await execAsync('wmctrl -l -p');
    const windows: WindowInfo[] = [];
    for (const line of stdout.trim().split('\n')) {
      if (!line.trim()) { continue; }
      const match = line.match(/^(0x[\da-f]+)\s+(-?\d+)\s+(\d+)\s+\S+\s+(.*)$/i);
      if (match) {
        windows.push({
          id: match[1],
          workspace: parseInt(match[2], 10),
          pid: parseInt(match[3], 10),
          wmClass: '',
          title: match[4].trim(),
        });
      }
    }
    return windows;
  }

  private async getWindowsGdbus(): Promise<WindowInfo[]> {
    const js = `
      JSON.stringify(global.get_window_actors().map(a => {
        let w = a.get_meta_window();
        return {
          id: String(w.get_id()),
          title: w.get_title() || '',
          pid: w.get_pid(),
          workspace: w.get_workspace() ? w.get_workspace().index() : -1,
          wmClass: w.get_wm_class() || ''
        };
      }))
    `.replace(/\n/g, ' ').trim();

    try {
      const { stdout } = await execAsync(
        `gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "${js.replace(/"/g, '\\"')}"`
      );
      const parsed = this.parseGdbusResult(stdout);
      if (parsed) {
        return JSON.parse(parsed);
      }
    } catch (e) {
      this.log(`gdbus getWindows failed: ${e}`);
    }
    return [];
  }

  /**
   * Find editor windows (Cursor / VSCode / Codium) matching a project folder name.
   */
  async findEditorWindows(folderName?: string): Promise<WindowInfo[]> {
    const allWindows = await this.getWindows();
    const editorPatterns = [/cursor/i, /code/i, /codium/i, /visual studio code/i];

    return allWindows.filter(w => {
      const isEditor = editorPatterns.some(p => p.test(w.title) || p.test(w.wmClass));
      if (!isEditor) { return false; }
      if (folderName) {
        return w.title.includes(folderName);
      }
      return true;
    });
  }

  // ── Window movement ──

  async moveWindowToWorkspace(windowId: string, workspace: number): Promise<boolean> {
    try {
      if (this._hasWmctrl) {
        await execAsync(`wmctrl -i -r ${windowId} -t ${workspace}`);
        this.log(`Moved window ${windowId} to workspace ${workspace}`);
        return true;
      }
      if (this._hasGdbus) {
        return this.moveWindowGdbus(windowId, workspace);
      }
    } catch (e) {
      this.log(`Error moving window: ${e}`);
    }
    return false;
  }

  private async moveWindowGdbus(windowId: string, workspace: number): Promise<boolean> {
    const js = `
      (function() {
        let actors = global.get_window_actors();
        for (let a of actors) {
          let w = a.get_meta_window();
          if (String(w.get_id()) === '${windowId}') {
            w.change_workspace_by_index(${workspace}, false);
            return true;
          }
        }
        return false;
      })()
    `.replace(/\n/g, ' ').trim();

    try {
      const { stdout } = await execAsync(
        `gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "${js.replace(/"/g, '\\"')}"`
      );
      return this.parseGdbusResult(stdout) === 'true';
    } catch (e) {
      this.log(`gdbus moveWindow failed: ${e}`);
      return false;
    }
  }

  /**
   * Move a window identified by title substring to a workspace.
   */
  async moveWindowByTitle(titleMatch: string, workspace: number): Promise<boolean> {
    try {
      if (this._hasWmctrl) {
        await execAsync(`wmctrl -r "${titleMatch}" -t ${workspace}`);
        this.log(`Moved window matching "${titleMatch}" to workspace ${workspace}`);
        return true;
      }
      const windows = await this.getWindows();
      const win = windows.find(w => w.title.includes(titleMatch));
      if (win) {
        return this.moveWindowToWorkspace(win.id, workspace);
      }
    } catch (e) {
      this.log(`Error moving window by title: ${e}`);
    }
    return false;
  }

  // ── Workspace info ──

  async getWorkspaceCount(): Promise<number> {
    try {
      if (this._hasWmctrl) {
        const { stdout } = await execAsync("wmctrl -d | wc -l");
        return parseInt(stdout.trim(), 10) || 4;
      }
      if (this._hasGdbus) {
        const { stdout } = await execAsync(
          `gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "global.workspace_manager.get_n_workspaces()"`
        );
        const result = this.parseGdbusResult(stdout);
        return result ? parseInt(result, 10) : 4;
      }
    } catch (e) {
      this.log(`Error getting workspace count: ${e}`);
    }
    return 4;
  }

  async getCurrentWorkspace(): Promise<number> {
    try {
      if (this._hasWmctrl) {
        const { stdout } = await execAsync("wmctrl -d | grep '\\*' | awk '{print $1}'");
        return parseInt(stdout.trim(), 10);
      }
      if (this._hasGdbus) {
        const { stdout } = await execAsync(
          `gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "global.workspace_manager.get_active_workspace_index()"`
        );
        const result = this.parseGdbusResult(stdout);
        return result ? parseInt(result, 10) : 0;
      }
    } catch (e) {
      this.log(`Error getting current workspace: ${e}`);
    }
    return 0;
  }

  async getWorkspaces(): Promise<WorkspaceInfo[]> {
    const count = await this.getWorkspaceCount();
    const current = await this.getCurrentWorkspace();
    const workspaces: WorkspaceInfo[] = [];

    if (this._hasWmctrl) {
      try {
        const { stdout } = await execAsync('wmctrl -d');
        for (const line of stdout.trim().split('\n')) {
          const match = line.match(/^(\d+)\s+([*-])/);
          if (match) {
            const idx = parseInt(match[1], 10);
            const namePart = line.split(/\s+/).pop() || `Workspace ${idx + 1}`;
            workspaces.push({
              index: idx,
              name: namePart === 'N/A' ? `Workspace ${idx + 1}` : namePart,
              isCurrent: match[2] === '*',
            });
          }
        }
        return workspaces;
      } catch {
        // fall through
      }
    }

    for (let i = 0; i < count; i++) {
      workspaces.push({
        index: i,
        name: `Workspace ${i + 1}`,
        isCurrent: i === current,
      });
    }
    return workspaces;
  }

  // ── Focus & switch ──

  async switchToWorkspace(workspace: number): Promise<void> {
    try {
      if (this._hasWmctrl) {
        await execAsync(`wmctrl -s ${workspace}`);
        return;
      }
      if (this._hasGdbus) {
        await execAsync(
          `gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "global.workspace_manager.get_workspace_by_index(${workspace}).activate(global.get_current_time())"`
        );
      }
    } catch (e) {
      this.log(`Error switching workspace: ${e}`);
    }
  }

  async focusWindow(windowId: string): Promise<void> {
    try {
      if (this._hasWmctrl) {
        await execAsync(`wmctrl -i -a ${windowId}`);
        return;
      }
      if (this._hasGdbus) {
        const js = `
          (function() {
            let actors = global.get_window_actors();
            for (let a of actors) {
              let w = a.get_meta_window();
              if (String(w.get_id()) === '${windowId}') {
                w.get_workspace().activate(global.get_current_time());
                w.activate(global.get_current_time());
                return true;
              }
            }
            return false;
          })()
        `.replace(/\n/g, ' ').trim();
        await execAsync(
          `gdbus call --session --dest org.gnome.Shell --object-path /org/gnome/Shell --method org.gnome.Shell.Eval "${js.replace(/"/g, '\\"')}"`
        );
      }
    } catch (e) {
      this.log(`Error focusing window: ${e}`);
    }
  }

  async focusWindowByTitle(titleMatch: string): Promise<boolean> {
    try {
      if (this._hasWmctrl) {
        await execAsync(`wmctrl -a "${titleMatch}"`);
        return true;
      }
      const windows = await this.getWindows();
      const win = windows.find(w => w.title.includes(titleMatch));
      if (win) {
        await this.focusWindow(win.id);
        return true;
      }
    } catch (e) {
      this.log(`Error focusing window by title: ${e}`);
    }
    return false;
  }

  // ── Open project in editor ──

  async openInEditor(projectPath: string): Promise<void> {
    const config = vscode.workspace.getConfiguration('gnomeWorkspaceManager');
    let cmd = config.get<string>('editorCommand', 'auto');

    if (cmd === 'auto') {
      cmd = await this.detectEditor();
    }

    try {
      const child = spawn(cmd, [projectPath], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    } catch (e) {
      this.log(`Error opening editor: ${e}`);
      vscode.window.showErrorMessage(`Failed to open project: ${e}`);
    }
  }

  private async detectEditor(): Promise<string> {
    for (const cmd of ['cursor', 'code', 'codium']) {
      try {
        await execAsync(`which ${cmd}`);
        return cmd;
      } catch {
        continue;
      }
    }
    return 'code';
  }

  // ── Utilities ──

  private parseGdbusResult(stdout: string): string | null {
    // gdbus output: (true, 'result_string') or (false, '')
    const match = stdout.match(/\(true,\s*'(.*)'\)/s);
    if (match) {
      return match[1].replace(/\\'/g, "'");
    }
    return null;
  }
}
