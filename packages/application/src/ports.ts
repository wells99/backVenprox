export interface Clock {
  now(): Date;
}

export interface IdGenerator {
  generate(): string;
}

// Adaptadores transacionais concretos em SQLite/MySQL; repositórios de negócio são incrementais.
// TRepositories vincula cada conjunto de repositórios à mesma transação.
export interface UnitOfWork<TRepositories> {
  run<TResult>(work: (repositories: TRepositories) => Promise<TResult>): Promise<TResult>;
}

export interface AuditEvent {
  readonly store_id: string;
  readonly operation_id: string;
  readonly device_id: string;
  readonly occurred_at: string;
  readonly action: string;
  readonly actor_user_id?: string;
  readonly permissions_version?: number;
  readonly authorization_origin?: 'technical' | 'online' | 'offline' | 'setup' | 'invitation';
  readonly authorization_id?: string;
}

// Auditoria durável participa da UnitOfWork; logs não implementam esta porta.
export interface Audit {
  append(event: AuditEvent): Promise<void>;
}

export interface RuntimeDiagnosticsRepository {
  inspect(): {
    readonly engine: 'sqlite';
    readonly engine_version: string;
    readonly storage_mode: 'ephemeral' | 'existing_file';
    readonly persistence_ready?: boolean;
    readonly schema_version?: number;
    readonly migration_state?: 'applied';
  };
}
