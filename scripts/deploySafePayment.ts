import { toNano } from '@ton/core';
import { SafePayment } from '../wrappers/SafePayment';
import { NetworkProvider } from '@ton/blueprint';

export async function run(provider: NetworkProvider) {
    const recipient = provider.sender().address!;

    const contract = provider.open(
        await SafePayment.fromInit(recipient, 'hackathon demo')
    );

    await contract.send(provider.sender(), { value: toNano('0.5') }, null);

    await provider.waitForDeploy(contract.address);

    console.log('Contract deployed at:', contract.address.toString());
    const details = await contract.getDetails();
    console.log('Details:', {
        recipient: details.recipient.toString(),
        condition: details.condition,
        released: details.released,
    });
}
