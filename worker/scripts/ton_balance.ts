import { Address, fromNano } from '@ton/core';
import { createClient } from './lib/client';

async function main() {
    const params = JSON.parse(process.env.VALIDANCE_PARAMS || '{}');
    const { address } = params;

    if (!address) {
        throw new Error('Missing required param: address');
    }

    const client = createClient();
    const addr = Address.parse(address);

    const balance = await client.getBalance(addr);
    const state = await client.getContractState(addr);

    const output = {
        address,
        balance: fromNano(balance),
        state: state.state,
        status: 'checked',
    };

    console.log(JSON.stringify(output));
}

main().catch((err) => {
    console.log(JSON.stringify({ error: err.message, status: 'failed' }));
    process.exit(1);
});
