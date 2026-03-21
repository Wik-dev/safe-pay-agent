import { TonClient } from '@ton/ton';

export function createClient(): TonClient {
    const endpoint = process.env.TON_API_ENDPOINT;
    if (!endpoint) throw new Error('TON_API_ENDPOINT not set');

    return new TonClient({
        endpoint,
        apiKey: process.env.TON_API_KEY || undefined,
    });
}
