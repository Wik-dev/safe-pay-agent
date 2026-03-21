import { toNano, Address, internal } from '@ton/core';
import { createClient } from './lib/client';
import { getWallet } from './lib/wallet';
import { SafePayment } from './lib/tact_SafePayment';

async function main() {
    const params = JSON.parse(process.env.VALIDANCE_PARAMS || '{}');
    const { recipient, amount, condition } = params;

    if (!recipient || !amount || !condition) {
        throw new Error('Missing required params: recipient, amount, condition');
    }

    const client = createClient();
    const { wallet, keyPair } = await getWallet();

    const walletContract = client.open(wallet);
    const recipientAddr = Address.parse(recipient);

    // Create SafePayment contract instance
    const contract = client.open(
        await SafePayment.fromInit(recipientAddr, condition)
    );

    // Deploy + deposit in one transaction
    const seqno = await walletContract.getSeqno();
    await walletContract.sendTransfer({
        seqno,
        secretKey: keyPair.secretKey,
        messages: [
            internal({
                to: contract.address,
                value: toNano(amount),
                init: contract.init,
                bounce: false,
            }),
        ],
    });

    // Wait for deployment
    let attempts = 0;
    while (attempts < 30) {
        await new Promise(r => setTimeout(r, 2000));
        const state = await client.getContractState(contract.address);
        if (state.state === 'active') break;
        attempts++;
    }

    if (attempts >= 30) {
        throw new Error('Contract deployment timed out');
    }

    const result = {
        contract_address: contract.address.toString(),
        recipient,
        amount,
        condition,
        status: 'deployed',
    };

    console.log(JSON.stringify(result));
}

main().catch(err => {
    console.error(JSON.stringify({ error: err.message, status: 'failed' }));
    process.exit(1);
});
