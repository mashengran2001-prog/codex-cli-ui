import type {
  AgentProviderId,
  AgentProviderInfo,
  OperationResult,
  RunEvent,
  RunRequest,
  SessionSummary,
} from "../src/types";

export interface ProviderRunContext {
  emit(event: RunEvent): void;
  notify(title: string, body: string): void;
}

export interface AgentProvider {
  readonly id: AgentProviderId;
  getInfo(): Promise<AgentProviderInfo>;
  refresh?(): Promise<AgentProviderInfo>;
  listSessions(cwd: string): Promise<SessionSummary[]>;
  getSession(id: string, cwd: string): Promise<SessionSummary | null>;
  startRun(request: RunRequest, context: ProviderRunContext): Promise<{ accepted: true }>;
  stopRun(runId: string): Promise<boolean> | boolean;
  install?(): Promise<OperationResult>;
  setCredential?(credential: string): Promise<AgentProviderInfo>;
  dispose?(): Promise<void> | void;
}

export class ProviderRegistry {
  private readonly providers = new Map<AgentProviderId, AgentProvider>();

  register(provider: AgentProvider) {
    if (this.providers.has(provider.id)) throw new Error(`Provider already registered: ${provider.id}`);
    this.providers.set(provider.id, provider);
    return provider;
  }

  get(id: AgentProviderId) {
    const provider = this.providers.get(id);
    if (!provider) throw new Error(`Unknown provider: ${id}`);
    return provider;
  }

  async listInfo() {
    return Promise.all([...this.providers.values()].map((provider) => provider.getInfo()));
  }

  async refresh(id: AgentProviderId) {
    const provider = this.get(id);
    return provider.refresh ? provider.refresh() : provider.getInfo();
  }

  async dispose() {
    await Promise.allSettled([...this.providers.values()].map((provider) => provider.dispose?.()));
  }
}
