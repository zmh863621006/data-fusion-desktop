export interface SourceTab {
  systemId: string;
  systemName: string;
  displayUrl: string;
  loading: boolean;
  error?: string;
}

export interface SourceTabsState {
  tabs: SourceTab[];
  activeSystemId: string | null;
}
