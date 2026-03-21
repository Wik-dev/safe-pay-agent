import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { toNano } from '@ton/core';
import '@ton/test-utils';
import { SafePayment } from '../wrappers/SafePayment';

describe('SafePayment', () => {
    let blockchain: Blockchain;
    let owner: SandboxContract<TreasuryContract>;
    let recipient: SandboxContract<TreasuryContract>;
    let contract: SandboxContract<SafePayment>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        owner = await blockchain.treasury('owner');
        recipient = await blockchain.treasury('recipient');

        contract = blockchain.openContract(
            await SafePayment.fromInit(recipient.address, 'test condition')
        );

        // Deploy + deposit 1 TON
        const deployResult = await contract.send(owner.getSender(), { value: toNano('1') }, null);
        expect(deployResult.transactions).toHaveTransaction({
            from: owner.address,
            to: contract.address,
            deploy: true,
            success: true,
        });
    });

    it('should deploy and verify initial state', async () => {
        const details = await contract.getDetails();
        expect(details.recipient.equals(recipient.address)).toBe(true);
        expect(details.condition).toBe('test condition');
        expect(details.released).toBe(false);

        const contractOwner = await contract.getOwner();
        expect(contractOwner.equals(owner.address)).toBe(true);

        const released = await contract.getIsReleased();
        expect(released).toBe(false);
    });

    it('should release funds to recipient', async () => {
        const recipientBefore = await recipient.getBalance();

        const result = await contract.send(owner.getSender(), { value: toNano('0.05') }, {
            $$type: 'Release',
            queryId: 0n,
        });

        // Funds sent to recipient
        expect(result.transactions).toHaveTransaction({
            from: contract.address,
            to: recipient.address,
            success: true,
        });

        // Contract destroyed after SendRemainingBalance + SendDestroyIfZero
        expect(result.transactions).toHaveTransaction({
            on: contract.address,
            destroyed: true,
        });

        const recipientAfter = await recipient.getBalance();
        expect(recipientAfter).toBeGreaterThan(recipientBefore);
    });

    it('should refund to owner', async () => {
        const result = await contract.send(owner.getSender(), { value: toNano('0.05') }, {
            $$type: 'Refund',
            queryId: 0n,
        });

        // Funds sent back to owner
        expect(result.transactions).toHaveTransaction({
            from: contract.address,
            to: owner.address,
            success: true,
        });

        // Contract destroyed
        expect(result.transactions).toHaveTransaction({
            on: contract.address,
            destroyed: true,
        });
    });

    it('should reject release from non-owner', async () => {
        const attacker = await blockchain.treasury('attacker');

        const result = await contract.send(attacker.getSender(), { value: toNano('0.05') }, {
            $$type: 'Release',
            queryId: 0n,
        });

        expect(result.transactions).toHaveTransaction({
            from: attacker.address,
            to: contract.address,
            success: false,
            exitCode: 132, // Access denied
        });

        // Contract still active (not destroyed)
        const released = await contract.getIsReleased();
        expect(released).toBe(false);
    });

    it('should self-destruct after release (no funds left for double-spend)', async () => {
        // Release succeeds — contract destroyed, all funds sent to recipient
        const result = await contract.send(owner.getSender(), { value: toNano('0.05') }, {
            $$type: 'Release',
            queryId: 0n,
        });

        // Contract is destroyed (no code, no data, no funds remain)
        expect(result.transactions).toHaveTransaction({
            on: contract.address,
            destroyed: true,
        });

        // Verify SendRemainingBalance sent everything
        expect(result.transactions).toHaveTransaction({
            from: contract.address,
            to: recipient.address,
            success: true,
        });
    });
});
