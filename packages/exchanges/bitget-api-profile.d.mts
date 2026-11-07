export function apiProfilePath(): string;
export function readApiProfiles(): Record<string, 'v2' | 'v3'>;
export function getBitgetApiVersion(id: number): 'v2' | 'v3';
export function applyBitgetApi(client: { options: any }, apiVersion: string): void;
