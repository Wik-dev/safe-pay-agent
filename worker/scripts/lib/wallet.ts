import { mnemonicToPrivateKey } from '@ton/crypto';
import { WalletContractV4 } from '@ton/ton';

export async function getWallet() {
    const mnemonic = process.env.TON_MNEMONIC;
    if (!mnemonic) throw new Error('TON_MNEMONIC not set');

    const words = mnemonic.split(' ');
    const keyPair = await mnemonicToPrivateKey(words);

    const wallet = WalletContractV4.create({
        workchain: 0,
        publicKey: keyPair.publicKey,
    });

    return { wallet, keyPair };
}
