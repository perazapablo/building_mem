export interface Project {
  id: string;
  name: string;
  description: string | null;
  project_type: string;
  tags: string[];
  context_summary: unknown;
  created_at: string;
  updated_at: string;
}

export interface MergeProjectCounts {
  source_id: string;
  source_name: string;
  target_id: string;
  target_name: string;
  notes: number;
  decisions: number;
  artifacts: number;
  code_entities: number;
  sessions: number;
  links: number;
  memory_relations: number;
}

export interface DeleteProjectCounts {
  project_id: string;
  project_name: string;
  notes: number;
  decisions: number;
  artifacts: number;
  code_entities: number;
  sessions: number;
  working_states: number;
  links: number;
  memory_relations: number;
}

export interface SessionRow {
  id: string;
  title: string;
  summary: unknown;
  project_id: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface WorkingState {
  session_id: string;
  focus: string;
  open_threads: string[];
  pinned_ids: string[];
  updated_at: string;
}

export interface NoteRow {
  id: string;
  project_id: string;
  content: string;
  tags: string[];
  topic_key: string | null;
  revision_count: number;
  status: string;
  importance: number;
  obsolete_reason: string | null;
  token_count: number | null;
  tokenizer_model: string | null;
  content_hash: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface DecisionRow {
  id: string;
  project_id: string;
  decision: string;
  reasoning: string;
  topic_key: string | null;
  revision_count: number;
  status: string;
  importance: number;
  obsolete_reason: string | null;
  token_count: number | null;
  tokenizer_model: string | null;
  content_hash: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface ArtifactRow {
  id: string;
  project_id: string;
  type: string;
  content: string;
  topic_key: string | null;
  revision_count: number;
  status: string;
  importance: number;
  obsolete_reason: string | null;
  token_count: number | null;
  tokenizer_model: string | null;
  content_hash: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface CodeEntity {
  id: string;
  project_id: string;
  kind: string;
  name: string;
  qualified_name: string;
  path: string;
  signature: string;
  summary: string;
  inputs: string;
  outputs: string;
  side_effects: string;
  tags: string[];
  status: string;
  importance: number;
  topic_key: string | null;
  revision_count: number;
  obsolete_reason: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface Link {
  id: string;
  from_type: string;
  from_id: string;
  to_type: string;
  to_id: string;
  created_at: string;
}

export interface Relation {
  sync_id: string;
  source_type: string;
  source_id: string;
  target_type: string;
  target_id: string;
  relation: string;
  reason: string;
  evidence: string;
  confidence: number;
  judgment_status: string;
  marked_by_actor: string;
  marked_by_kind: string;
  marked_by_model: string;
  session_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface EventRow {
  id: string;
  entity_type: string;
  entity_id: string;
  op: string;
  payload_before: unknown;
  payload_after: unknown;
  ts: string;
}

export interface TableCounts {
  projects: number;
  sessions: number;
  notes: number;
  decisions: number;
  artifacts: number;
  code_entities: number;
  links: number;
  memory_relations: number;
  working_state: number;
  events: number;
}

export interface SearchAllResponse {
  query: string;
  project_id: string | null;
  include_obsolete: boolean;
  limit: number;
  results: SearchAllResult[];
}

export interface ProjectContextRow {
  id: string;
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

export interface DecisionContextRow {
  id: string;
  decision: string;
  reasoning: string;
  topic_key: string | null;
  revision_count: number;
  status: string;
  importance: number;
  obsolete_reason: string | null;
  created_at: string;
  updated_at: string | null;
}

export interface ArtifactContextRow {
  id: string;
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

export interface ProjectContext {
  notes: ProjectContextRow[];
  decisions: DecisionContextRow[];
  artifacts: ArtifactContextRow[];
}

export interface ContextSummary {
  capabilities?: string[];
  architecture?: string;
  constraints?: string[];
  pending_work?: string[];
  notes?: string;
}

export interface FileEditStat {
  path: string;
  edits: number;
}

export interface BashEffectStat {
  cmd: string;
  exit: number;
}

export interface SessionStats {
  duration_min?: number;
  turns?: number;
  commits?: string[];
  files_edited?: FileEditStat[];
  bash_effects?: BashEffectStat[];
  memory_writes?: Record<string, number>;
  code_entities_touched?: string[];
  tool_errors?: number;
  last_focus?: string;
}

export interface SessionFocus {
  session_id: string;
  project_id: string;
  focus: string;
  set_at: string;
  updated_at: string;
}

export interface ProjectPath {
  id: string;
  project_id: string;
  path: string;
  path_key: string;
  created_at: string;
}

export type ThreadStatus = 'open' | 'done' | 'dropped' | 'stale';

export interface ProjectThread {
  id: string;
  project_id: string;
  thread: string;
  status: ThreadStatus;
  opened_in: string;
  closed_in: string | null;
  close_reason: string | null;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface SessionSummary {
  goal?: string;
  outcome?: string;
  decisions_ref?: string[];
  artifacts_ref?: string[];
  pending?: string[];
  blockers?: string[];
  threads_closed?: string[];
  stats?: SessionStats | null;
  notes?: string;
}

export type ContextItem =
  | ({ type: 'note'; content: string } & ContextItemBase)
  | ({ type: 'decision'; decision: string; reasoning: string } & ContextItemBase)
  | ({ type: 'artifact'; artifact_type: string; content: string } & ContextItemBase)
  | ({
      type: 'code_entity';
      kind: string;
      name: string;
      qualified_name: string;
      path: string;
      signature: string;
      summary: string;
      inputs: string;
      outputs: string;
      side_effects: string;
      tags: string[];
    } & ContextItemBase);

interface ContextItemBase {
  id: string;
  project_id: string;
  status: string;
  importance: number;
  obsolete_reason: string | null;
  created_at: string;
  updated_at: string | null;
  token_count: number;
  tokenizer_model: string;
  topic_key: string | null;
  revision_count: number;
  sort_ts: string;
}

export interface BuildContextResponse {
  project_id: string;
  session_id: string | null;
  token_budget: number;
  effective_budget: number;
  tokenizer_model: string;
  used_tokens: number;
  omitted_count: number;
  conflict_exclusions: number;
  graph_expansions: number;
  items: ContextItem[];
}

export interface GetRelatedResponse {
  root: { type: string; id: string };
  depth: number;
  links: Link[];
  entities: { key: string; type: string; entity: unknown }[];
}

export interface CodeEntityContext {
  project_id: string;
  query: string;
  code_entities: CodeEntity[];
}

export type SearchAllResult =
  | { type: 'note'; id: string; project_id: string; content: string; tags: string[]; topic_key: string | null; revision_count: number; status: string; importance: number; rank: number }
  | { type: 'decision'; id: string; project_id: string; decision: string; reasoning: string; topic_key: string | null; revision_count: number; status: string; importance: number; rank: number }
  | { type: 'artifact'; id: string; project_id: string; artifact_type: string; content: string; topic_key: string | null; revision_count: number; status: string; importance: number; rank: number }
  | { type: 'code_entity'; id: string; project_id: string; kind: string; name: string; qualified_name: string; path: string; topic_key: string | null; revision_count: number; status: string; importance: number; rank: number };
