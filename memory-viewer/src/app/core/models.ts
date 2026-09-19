/** Formas que serializa el crate `mcp_memory`. Copiadas de los structs, no inferidas. */

export interface ContextSummary {
  capabilities: string[];
  architecture: string;
  constraints: string[];
  pending_work: string[];
  notes?: string | null;
}

export interface Project {
  id: string;
  name: string;
  description: string | null;
  project_type: string;
  tags: string[];
  context_summary: ContextSummary | null;
  created_at: string;
  updated_at: string;
}

export interface SessionIndexRow {
  id: string;
  title: string;
  project_id: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface Alternative {
  option: string;
  rejected_because: string | null;
}

export interface DecisionRecord {
  id: string;
  project_id: string;
  topic_key: string;
  session_id: string;
  phase: string | null;
  created_at: string;
  statement: string;
  forces: string[];
  alternatives: Alternative[];
  consequences: string[];
  origin: string;
  confidence: string;
  status: string;
  status_reason: string | null;
  supersedes: string | null;
  superseded_by: string | null;
}

export interface ProjectThread {
  id: string;
  project_id: string;
  thread: string;
  status: string;
  opened_in: string | null;
  closed_in: string | null;
  close_reason: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface FileEdit {
  path: string;
  edits: number;
}

export interface SessionStats {
  duration_min: number;
  turns: number;
  commits: string[];
  files_edited: FileEdit[];
  memory_writes: Record<string, number>;
  code_entities_touched: string[];
  tool_errors: number;
  last_focus: string;
}

export interface SessionSummary {
  goal: string;
  outcome: string;
  decisions_ref: string[];
  artifacts_ref: string[];
  pending: string[];
  blockers: string[];
  threads_closed: string[];
  stats?: SessionStats | null;
  notes?: string | null;
}

export interface SessionRow {
  id: string;
  title: string;
  summary: SessionSummary | null;
  project_id: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface GraphNode {
  id: string;
  kind: string;
  label: string;
  clave: string;
  texto: string;
  tags: string;
  creado: string;
  importance: number;
  degree: number;
}

export interface GraphEdge {
  sync_id: string;
  source: string;
  target: string;
  relation: string;
  reason: string;
  evidence: string;
  confidence: number;
  judgment_status: string;
}

export interface ProjectGraph {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface Note {
  id: string;
  project_id: string;
  content: string;
  tags: string[];
  topic_key: string | null;
  revision_count: number;
  status: string;
  importance: number;
  obsolete_reason: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface Artifact {
  id: string;
  project_id: string;
  type: string;
  content: string;
  topic_key: string | null;
  revision_count: number;
  status: string;
  importance: number;
  obsolete_reason: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface FocusEntry {
  id: string;
  session_id: string;
  project_id: string;
  focus: string;
  provisional: boolean;
  set_at: string;
}

export interface DiaActividad {
  fecha: string;
  sesiones: number;
  minutos: number;
}

export interface OrigenDecisiones {
  explicito: number;
  implicito: number;
  inferido: number;
}

export interface Dashboard {
  sesiones: number;
  dias_activos: number;
  primera: string | null;
  ultima: string | null;
  sesiones_medidas: number;
  minutos_totales: number;
  minutos_mediana: number;
  minutos_max: number;
  con_cierre: number;
  auto_guardadas: number;
  decisiones: number;
  origen: OrigenDecisiones;
  notas: number;
  artefactos: number;
  entidades_codigo: number;
  hilos_abiertos: number;
  commits: number;
  archivos_editados: number;
  dias: DiaActividad[];
}

export interface ProjectPath {
  id: string;
  project_id: string;
  path: string;
  path_key: string;
  created_at: string;
}

/**
 * Lo que dejó una sesión. `decisiones` e `hilos` salen declarados de la propia
 * fila; `notas` y `artefactos` se deducen por ventana de tiempo, y por eso
 * viajan `desde`/`hasta` y `ventana_confiable`.
 */
export interface SessionBundle {
  session_id: string;
  project_id: string | null;
  desde: string | null;
  hasta: string | null;
  ventana_confiable: boolean;
  decisiones: DecisionRecord[];
  hilos: ProjectThread[];
  notas: Note[];
  artefactos: Artifact[];
  focus: FocusEntry[];
}
