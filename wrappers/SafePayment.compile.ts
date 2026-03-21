import { CompilerConfig } from '@ton/blueprint';

export const compile: CompilerConfig = {
    lang: 'tact',
    target: 'contracts/safe_payment.tact',
    options: {
        debug: true,
    },
};
