export interface ManagedProject {
  id: string;
  name: string;
  path: string;
  /** 0-based GNOME workspace index, -1 means unassigned */
  targetWorkspace: number;
  group: string;
  pinned: boolean;
  notes: string;
  lastOpened: number;
  color: string;
  /** Whether to auto-open this project on startup */
  autoOpen: boolean;
}

export interface WorkspaceInfo {
  index: number;
  name: string;
  isCurrent: boolean;
}

export interface WindowInfo {
  id: string;
  title: string;
  pid: number;
  workspace: number;
  wmClass: string;
}

export type DisplayMode = 'x11' | 'wayland' | 'unknown';

export const PROJECT_COLORS = [
  { id: 'none', label: 'None', hex: '' },
  { id: 'red', label: 'Red', hex: '#e74c3c' },
  { id: 'orange', label: 'Orange', hex: '#e67e22' },
  { id: 'yellow', label: 'Yellow', hex: '#f1c40f' },
  { id: 'green', label: 'Green', hex: '#2ecc71' },
  { id: 'blue', label: 'Blue', hex: '#3498db' },
  { id: 'purple', label: 'Purple', hex: '#9b59b6' },
  { id: 'pink', label: 'Pink', hex: '#e91e63' },
  { id: 'teal', label: 'Teal', hex: '#00bcd4' },
];

export function createDefaultProject(path: string, name?: string): ManagedProject {
  return {
    id: generateId(),
    name: name || path.split('/').pop() || path,
    path,
    targetWorkspace: -1,
    group: '',
    pinned: false,
    notes: '',
    lastOpened: 0,
    color: '',
    autoOpen: false,
  };
}

export function generateId(): string {
  return Date.now().toString(36) + Math.random().toString(36).substring(2, 9);
}
