# GNOME Workspace Manager

A Cursor/VSCode extension that automatically places project windows on specific GNOME workspaces. Stop rearranging windows after every reboot.

## Features

### Core — Workspace Placement
- **Auto-place on startup** — Automatically moves the current editor window to its assigned GNOME workspace when Cursor/VSCode starts
- **Place All** — One command to move every managed project window to its assigned workspace (`Ctrl+Alt+W`)
- **Place Current** — Move just the current window to its assigned workspace

### Project Management
- **Quick Switch** — Fuzzy-search across all managed projects and instantly switch to or open them (`Ctrl+Alt+P`)
- **Open / Switch** — Open a project in a new window, or focus its window if already open
- **Scan directories** — Auto-discover projects by detecting `.git`, `package.json`, `Cargo.toml`, `go.mod`, etc.
- **Groups** — Organize projects into groups (work, personal, oss, ...)
- **Pin favorites** — Pin frequently used projects to the top
- **Color tags** — Assign colors to projects for visual distinction
- **Notes** — Attach quick notes to any project
- **Auto-open** — Flag projects to automatically open when Cursor starts
- **Health check** — Detect and clean up projects whose paths no longer exist

### UI
- **Sidebar tree views** — Workspace overview and project list in the activity bar
- **Management panel** — Full webview with workspace grid, project table, inline editing, and drag-and-drop assignment
- **Status bar** — Shows current GNOME workspace number; click to open management panel

### Configuration
- **Import / Export** — Back up and restore your project list as JSON
- **Custom workspace names** — Give meaningful names to your GNOME workspaces
- **Configurable scan** — Set scan directories, depth, and project indicators

## Prerequisites

Install window management tools for your display server:

```bash
# X11 (recommended — works for Cursor/Electron via XWayland too)
sudo apt install wmctrl xdotool

# Wayland (fallback via GNOME Shell D-Bus eval)
# gdbus is usually pre-installed with GNOME
```

> **Note:** Cursor and most Electron apps run under XWayland by default, so `wmctrl` typically works even on a Wayland session.

## Getting Started

1. **Install dependencies and compile:**
   ```bash
   cd gnome-workspace-manager
   npm install
   npm run compile
   ```

2. **Install the extension locally:**
   ```bash
   # Option A: symlink into extensions directory
   ln -s "$(pwd)" ~/.vscode/extensions/gnome-workspace-manager
   # or for Cursor:
   ln -s "$(pwd)" ~/.cursor/extensions/gnome-workspace-manager

   # Option B: package and install
   npx @vscode/vsce package
   code --install-extension gnome-workspace-manager-0.1.0.vsix
   ```

3. **Add your first project:** Open the command palette → `GWM: Add Current Project to Manager`

4. **Assign a workspace:** Right-click the project in the sidebar → `Assign GNOME Workspace`

5. **Place windows:** `Ctrl+Alt+W` or command palette → `GWM: Place All Projects to Assigned Workspaces`

## Commands

| Command | Keybinding | Description |
|---------|------------|-------------|
| `GWM: Place All` | `Ctrl+Alt+W` | Move all windows to assigned workspaces |
| `GWM: Quick Switch` | `Ctrl+Alt+P` | Fuzzy-find and switch to any project |
| `GWM: Add Current Project` | — | Add the current workspace folder |
| `GWM: Open Management Panel` | — | Open the full management UI |
| `GWM: Scan for Projects` | — | Discover projects in directories |
| `GWM: Open Project` | — | Open a managed project in new window |
| `GWM: Switch to Project` | — | Focus an open project's window |
| `GWM: Check Health` | — | Find projects with missing paths |
| `GWM: Export / Import` | — | Backup and restore configuration |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `autoPlaceOnStartup` | `true` | Auto-place current window on startup |
| `startupDelay` | `2000` | Delay (ms) before auto-place |
| `editorCommand` | `auto` | Command to open projects (`cursor`, `code`, `codium`, or `auto`) |
| `scanDirectories` | `[]` | Directories to scan for projects |
| `scanDepth` | `2` | How deep to scan |
| `projectIndicators` | `.git`, `package.json`, ... | Files that indicate a directory is a project |
| `windowMatchStrategy` | `title` | How to match windows to projects |

## How It Works

The extension matches editor windows to projects by folder name in the window title (e.g. `my-project — Cursor`). It uses:

- **X11 / XWayland:** `wmctrl` for listing, moving, and focusing windows
- **Wayland (GNOME Shell):** `gdbus` D-Bus calls to `org.gnome.Shell.Eval` for window management

Project assignments are persisted in VS Code's global state, so they survive across restarts and machines (via Settings Sync).

## License

MIT
