export interface RawUsageRecord {
  timestamp: string;
  workspace_id: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
}

export interface RawCostRecord {
  timestamp: string;
  workspace_id: string;
  amount_usd: number;
}

export interface UsageReportResponse {
  data: RawUsageRecord[];
  has_more: boolean;
  next_page?: string;
}

export interface CostReportResponse {
  data: RawCostRecord[];
  has_more: boolean;
  next_page?: string;
}
