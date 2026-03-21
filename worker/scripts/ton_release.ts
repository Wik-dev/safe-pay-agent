import { Address, toNano, beginCell, internal } from '@ton/core';
import { createClient } from './lib/client';
import { getWallet } from './lib/wallet';
import { SafePayment } from './lib/tact_SafePayment';

const RELEASE_OPCODE = 408342921; // 0x1856D189

async function main() {
    const params = JSON.parse(process.env.VALIDANCE_PARAMS || '{}');
    const { contract_address } = params;

    if (!contract_address) {
        throw new Error('Missing required param: contract_address');
    }

    const client = createClient();
    const { wallet, keyPair } = await getWallet();
    const walletContract = client.open(wallet);

    const addr = Address.parse(contract_address);
    const contract = client.open(SafePayment.fromAddress(addr));

    // Verify contract state
    const details = await contract.getDetails();
    if (details.released) {
        throw new Error('Contract already released');
    }

    // Send Release message via wallet transfer
    const body = beginCell()
        .storeUint(RELEASE_OPCODE, 32)
        .storeUint(0, 64) // queryId
        .endCell();

    const seqno = await walletContract.getSeqno();
    await walletContract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: [
            internal({ to: addr, value: toNano('0.05'), body, bounce: true }),
        ],
    });

    // Wait for contract destruction (release sends remaining balance + destroys)
    let attempts = 0;
    while (attempts < 20) {
        await new Promise(r => setTimeout(r, 2000));
        const state = await client.getContractState(addr);
        if (state.state !== 'active') break;
        attempts++;
    }

    const result = {
        contract_address,
        action: 'release',
        recipient: details.recipient.toString(),
        status: 'released',
    };

    console.log(JSON.stringify(result));
}

main().catch(err => {
    console.error(JSON.stringify({ error: err.message, status: 'failed' }));
    process.exit(1);
});
