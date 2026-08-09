import { Injectable } from '@angular/core';
import { invoke } from '@tauri-apps/api/core';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import {
  ArtifactRow,
  BuildContextResponse,
  CodeEntity,
  CodeEntityContext,
  DecisionRow,
  DeleteProjectCounts,
  MergeProjectCounts,
  EventRow,
  GetRelatedResponse,
  Link,
  NoteRow,
  Project,
  ProjectContext,
  Relation,
  SearchAllResponse,
  SessionRow,
  TableCounts,
  WorkingState,
} from './models';

@Injectable({ providedIn: 'root' })
export class TauriService {
  getDbPath(): Promise<string> {
    return invoke<string>('get_db_path');
  }

  async pickDbAndOpen(): Promise<string | null> {
    const selected = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: 'SQLite', extensions: ['db', 'sqlite', 'sqlite3'] }],
    });
    if (!selected || Array.isArray(selected)) return null;
    return invoke<string>('open_db', { path: selected });
  }

  getTableCounts() {
    return invoke<TableCounts>('get_table_counts');
  }

  listProjects() {
    return invoke<Project[]>('list_projects');
  }

  getProject(id: string) {
    return invoke<Project | null>('get_project', { id });
  }

  deleteProject(id: string) {
    return invoke<DeleteProjectCounts>('delete_project', { id });
  }

  mergeProject(sourceId: string, targetId: string) {
    return invoke<MergeProjectCounts>('merge_project', { sourceId, targetId });
  }

  listSessions(projectId?: string) {
    return invoke<SessionRow[]>('list_sessions', { projectId: projectId ?? null });
  }

  getSession(id: string) {
    return invoke<SessionRow | null>('get_session', { id });
  }

  getWorkingState(sessionId: string) {
    return invoke<WorkingState | null>('get_working_state', { sessionId });
  }

  listWorkingStates() {
    return invoke<WorkingState[]>('list_working_states');
  }

  listNotes(projectId?: string) {
    return invoke<NoteRow[]>('list_notes', { projectId: projectId ?? null });
  }

  listDecisions(projectId?: string) {
    return invoke<DecisionRow[]>('list_decisions', { projectId: projectId ?? null });
  }

  listArtifacts(projectId?: string) {
    return invoke<ArtifactRow[]>('list_artifacts', { projectId: projectId ?? null });
  }

  listCodeEntities(projectId?: string) {
    return invoke<CodeEntity[]>('list_code_entities', { projectId: projectId ?? null });
  }

  listLinks() {
    return invoke<Link[]>('list_links');
  }

  listRelations(limit = 500) {
    return invoke<Relation[]>('list_relations', { limit });
  }

  listEvents(entityType?: string, entityId?: string, limit = 500) {
    return invoke<EventRow[]>('list_events', {
      entityType: entityType ?? null,
      entityId: entityId ?? null,
      limit,
    });
  }

  getAuditTrail(entityType: string, entityId: string) {
    return invoke<EventRow[]>('get_audit_trail', { entityType, entityId });
  }

  getRelationsForEntity(entityType: string, entityId: string) {
    return invoke<Relation[]>('get_relations_for_entity', { entityType, entityId });
  }

  getProjectContext(projectId: string, limit = 50, includeObsolete = false) {
    return invoke<ProjectContext>('get_project_context', {
      projectId,
      limit,
      includeObsolete,
    });
  }

  buildContext(
    projectId: string,
    tokenBudget: number,
    sessionId?: string,
    tokenizerModel?: string,
  ) {
    return invoke<BuildContextResponse>('build_context', {
      projectId,
      tokenBudget,
      sessionId: sessionId ?? null,
      tokenizerModel: tokenizerModel ?? null,
    });
  }

  getPendingJudgments(projectId?: string, limit = 200) {
    return invoke<Relation[]>('get_pending_judgments', {
      projectId: projectId ?? null,
      limit,
    });
  }

  getCodeEntity(id: string) {
    return invoke<CodeEntity | null>('get_code_entity', { id });
  }

  searchCodeEntities(query: string, projectId?: string, limit = 50) {
    return invoke<CodeEntity[]>('search_code_entities', {
      query,
      projectId: projectId ?? null,
      limit,
    });
  }

  getCodeEntityContext(projectId: string, query: string, limit = 20) {
    return invoke<CodeEntityContext>('get_code_entity_context', {
      projectId,
      query,
      limit,
    });
  }

  searchNotesQ(query: string, projectId?: string, limit = 50) {
    return invoke<NoteRow[]>('search_notes', {
      query,
      projectId: projectId ?? null,
      limit,
    });
  }

  getRelated(entityType: string, entityId: string, depth = 1) {
    return invoke<GetRelatedResponse>('get_related', {
      entityType,
      entityId,
      depth,
    });
  }

  searchAll(query: string, projectId?: string, limit = 50) {
    return invoke<SearchAllResponse>('search_all', {
      query,
      projectId: projectId ?? null,
      limit,
    });
  }
}
