import { Address, fromNano } from '@ton/core';
import { createClient } from './lib/client';
import { getWallet } from './lib/wallet';

async function main() {
    const params = JSON.parse(process.env.VALIDANCE_PARAMS || '{}');
    let { address } = params;

    // Default to the bot's own wallet address
    if (!address) {
        const { wallet } = await getWallet();
        address = wallet.address.toString({ bounceable: true, testOnly: true });
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
