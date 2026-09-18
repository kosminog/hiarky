export interface HookUsage {
  /** Hook function name, e.g. "useState", "useCustomThing" */
  name: string;
  /** Extra context, e.g. the state variable name for useState */
  detail?: string;
}

export interface RenderedChild {
  /** JSX element name as written, e.g. "Button" or "Ctx.Provider" */
  name: string;
  /** Resolved component id if the name maps to a project component */
  id?: string;
  /** Package name when the component comes from node_modules */
  external?: string;
}

export interface ComponentInfo {
  /** Stable id: "<relative file>#<component name>" */
  id: string;
  name: string;
  file: string;
  kind: 'function' | 'class';
  export: 'default' | 'named' | 'none';
  props: string[];
  hooks: HookUsage[];
  renders: RenderedChild[];
}

export interface ImportBinding {
  /** Local identifier the import is bound to */
  local: string;
  /** Exported name at the source ("default" for default imports, "*" for namespace) */
  imported: string;
  /** Module specifier as written */
  source: string;
}

export interface FileAnalysis {
  file: string;
  components: ComponentInfo[];
  imports: ImportBinding[];
  parseError?: string;
}

export interface GitInfo {
  commit: string;
  branch: string;
  dirty: boolean;
}

export interface Snapshot {
  hiarky: number;
  id: string;
  timestamp: string;
  project: {
    root: string;
    name: string;
  };
  git: GitInfo | null;
  stats: {
    files: number;
    components: number;
  };
  components: ComponentInfo[];
  /** Component ids never rendered by another project component */
  roots: string[];
  /** Files that could not be parsed */
  errors?: { file: string; message: string }[];
}
