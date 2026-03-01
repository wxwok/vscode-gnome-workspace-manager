import * as vscode from 'vscode';
import { GnomeHelper } from './gnomeHelper';

export class StatusBarManager {
  private item: vscode.StatusBarItem;
  private intervalHandle: ReturnType<typeof setInterval> | undefined;

  constructor(private gnome: GnomeHelper) {
    this.item = vscode.window.createStatusBarItem(
      vscode.StatusBarAlignment.Left,
      50,
    );
    this.item.command = 'gwm.openManagement';
    this.item.tooltip = 'GNOME Workspace Manager — Click to open';
    this.item.show();
    this.update();

    this.intervalHandle = setInterval(() => this.update(), 10_000);
  }

  async update(): Promise<void> {
    try {
      const current = await this.gnome.getCurrentWorkspace();
      const total = await this.gnome.getWorkspaceCount();
      this.item.text = `$(layout) WS ${current + 1}/${total}`;
    } catch {
      this.item.text = '$(layout) WS ?';
    }
  }

  dispose(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
    }
    this.item.dispose();
  }
}
