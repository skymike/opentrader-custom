export function presentCommentary(saved: unknown, state: unknown, settings: unknown, now?: number): {
  enabled: boolean; model: string; role: string; status: string; facts: unknown;
  generatedAt?: number; summary?: string; explanations?: { symbol: string; text: string }[]; analysis?: { symbol: string; text: string }[];
};
