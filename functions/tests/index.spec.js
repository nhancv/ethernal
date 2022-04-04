jest.mock('ethers', () => {
    const original = jest.requireActual('ethers');
    const provider = {
        send: (command) => {
            return new Promise((resolve) => {
                switch(command) {
                    case 'debug_traceTransaction':
                        resolve([{ trace: 'step' }])
                        break;
                    case 'hardhat_impersonateAccount':
                        resolve(true);
                        break;
                    case 'evm_unlockUnknownAccount':
                        resolve(false);
                        break;
                    default:
                        resolve(false);
                        break;
                }
            })
        }
    };
    const ethers = jest.fn(() => provider);
    const providers = {
        JsonRpcProvider: jest.fn(() => { return provider }),
        WebSocketProvider: jest.fn(() => { return provider })
    };

    Object.defineProperty(ethers, 'providers', { value: providers });
    Object.defineProperty(ethers, 'BigNumber', { value: original.BigNumber });
    Object.defineProperty(ethers, 'utils', { value: original.utils });

    return ethers;
});
const ethers = require('ethers');

jest.mock('axios', () => ({
    get: jest.fn()
}));
const axios = require('axios');

jest.mock('stripe', () => {
    return () => {
        return {
            billingPortal: {
                sessions: {
                    create: () => {
                        return new Promise((resolve) => resolve({ url: 'https://billing.stripe.com/session/ses_123' }));
                    }
                }
            },
            checkout: {
                sessions: {
                    create: () => {
                        return new Promise((resolve) => resolve({ url: 'https://checkout.stripe.com/pay/cs_test_a1iLHyCoBSlctiheACjbxq' }));
                    }
                }
            },
            subscriptionItems: {
                createUsageRecord: jest.fn()
            }
        }
    }
});
const stripe = require('stripe')('1234');

jest.mock('../lib/firebase', () => {
    const actual = jest.requireActual('../lib/firebase')
    return {
        ...actual,
        getUser: jest.fn().mockResolvedValue({ data: () => ({ apiKey: '1234' })}),
        getWorkspaceByName: jest.fn().mockResolvedValue({ rpcServer: 'rpc.com' }),
        storeTransaction: jest.fn().mockResolvedValue({ hash: '0x1234' }),
        canUserSyncContract: jest.fn().mockResolvedValue(true),
        storeContractData: jest.fn().mockResolvedValue(),
        storeBlock: jest.fn().mockResolvedValue({ blockNumber: 1, transactions: [] }),
        getContractData: jest.fn().mockResolvedValue(),
        storeContractDependencies: jest.fn().mockResolvedValue(),
        storeTrace: jest.fn().mockResolvedValue(),
        storeContractArtifact: jest.fn().mockResolvedValue(),
    }
});
const { storeContractArtifact, storeTrace, getUser, storeContractData, storeTransaction, storeBlock, canUserSyncContract, getContractData, storeContractDependencies } = require('../lib/firebase');

jest.mock('../lib/tasks', () => ({
    enqueueTask: jest.fn().mockResolvedValue(true)
}));
const { enqueueTask } = require('../lib/tasks');

jest.mock('../lib/rpc', () => ({
    ProviderConnector: function() {
        return {
            fetchTransactionReceipt: jest.fn().mockResolvedValue({ status: 1, contractAddress: '0xabcd' }),
            fetchBlockWithTransactions: jest.fn().mockResolvedValue({
                number: 1,
                timestamp: 1234,
                transactions: [{ hash: '0x1234' }]
            })
        }
    }
}));

jest.mock('../lib/transactions', () => ({
    processTransactions: jest.fn().mockResolvedValue(true)
}));
const { processTransactions } = require('../lib/transactions');

const pubSubMock = require('google-pubsub-mock');
const PubSub = require('@google-cloud/pubsub');

const index = require('../index');
const Helper = require('./helper');
const Trace = require('./fixtures/ProcessedTrace.json');
const Transaction = require('./fixtures/Transaction.json');
const TransactionReceipt = require('./fixtures/TransactionReceipt.json');
const ABI = require('./fixtures/ABI.json');
const AmalfiContract = require('./fixtures/AmalfiContract.json');
const Block = require('./fixtures/Block.json');
let auth = { auth: { uid: '123' }};
let helper;

const pubSubMockInstance = pubSubMock.setUp({
    topics: {
        'bill-usage': {
            subscriptions: ['test']
        }
    }
});

beforeEach(() => {
    pubSubMockInstance.clearState();
    jest.clearAllMocks();
});

describe('resyncBlocks', () => {
    beforeEach(() => {
        helper = new Helper(process.env.GCLOUD_PROJECT);
    });

    it('Should enqueue a batch sync task', async () => {
        const wrapped = helper.test.wrap(index.resyncBlocks);
        const data = {
            workspace: 'hardhat',
            fromBlock: 1,
            toBlock: 5
        };

        await wrapped(data, auth);

        expect(enqueueTask).toBeCalledWith('batchBlockSyncTask', {
            userId: '123',
            workspace: 'hardhat',
            fromBlock: 1,
            toBlock: 5
        });
    });

    afterEach(() => helper.clean());
});

describe('batchBlockSyncTask', () => {
    beforeEach(() => {
        helper = new Helper(process.env.GCLOUD_PROJECT);
    });

    it('Should enqueue multiple block sync task', async () => {
        const wrapped = helper.test.wrap(index.batchBlockSyncTask);
        const data = {
            userId: '123',
            workspace: 'hardhat',
            fromBlock: 1,
            toBlock: 5
        };

        await wrapped(data, auth);

        for (let i = 1; i < 6; i++)
            expect(enqueueTask).toBeCalledWith('blockSyncTask', {
                userId: '123',
                workspace: 'hardhat',
                blockNumber: i
            });
    });

    afterEach(() => helper.clean());
});
describe('transactionSyncTask', () => {
    beforeEach(() => {
        helper = new Helper(process.env.GCLOUD_PROJECT);
    });

    it('Should store & process the transaction', async () => {
        const wrapped = helper.test.wrap(index.transactionSyncTask);

        const data = {
            userId: '123',
            workspace: 'hardhat',
            transaction: { hash: '0x1234', to: '0xabcd', receipt: { contractAddress: '0xabcd' }},
            timestamp: 1234
        };

        await wrapped(data, auth);

        const expectedTx = {
            error: '',
            hash: '0x1234',
            to: '0xabcd',
            receipt: { status: 1, contractAddress: '0xabcd' },
            tokenBalanceChanges: {},
            tokenTransfers: [],
            timestamp: 1234
        }
        expect(storeTransaction).toBeCalledWith('123', 'hardhat', expectedTx);
        expect(processTransactions).toBeCalledWith('123', 'hardhat', [expectedTx]);
    });

    it('Should store the contract if no to field', async () => {
        const wrapped = helper.test.wrap(index.transactionSyncTask);

        const data = {
            userId: '123',
            workspace: 'hardhat',
            transaction: { hash: '0x1234', receipt: { contractAddress: '0xabcd' }},
            timestamp: 1234
        };

        await wrapped(data, auth);

        const expectedTx = {
            error: '',
            hash: '0x1234',
            receipt: { status: 1 },
            tokenBalanceChanges: {},
            tokenTransfers: []
        }
        expect(storeContractData).toBeCalledWith('123', 'hardhat', '0xabcd', {
            address: '0xabcd',
            timestamp: 1234
        });
    });

    afterEach(() => helper.clean());
});

describe('blockSyncTask', () => {
    beforeEach(() => {
        helper = new Helper(process.env.GCLOUD_PROJECT);
    });

    it('Should store the block & queue tx fetching', async () => {
        const wrapped = helper.test.wrap(index.blockSyncTask);

        const data = {
            userId: '123',
            workspace: 'hardhat',
            blockNumber: 1
        };

        await wrapped(data, auth);

        const syncedBlock = {
            number: 1,
            timestamp: 1234,
            transactions: [{ hash: '0x1234' }]
        };

        expect(storeBlock).toHaveBeenCalledWith('123', 'hardhat', syncedBlock);
        expect(enqueueTask).toHaveBeenCalledWith('transactionSyncTask', {
            userId: '123',
            workspace: 'hardhat',
            transaction: { hash: '0x1234' },
            timestamp: 1234
        });
    });

    afterEach(() => helper.clean());
});

describe('serverSideBlockSync', () => {
    beforeEach(() => {
        helper = new Helper(process.env.GCLOUD_PROJECT);
    });

    it('Should enqueue block sync', async () => {
        const wrapped = helper.test.wrap(index.serverSideBlockSync);

        const data = {
            blockNumber: 1,
            workspace: 'hardhat'
        };

        await wrapped(data, auth);

        expect(enqueueTask).toHaveBeenCalledWith('blockSyncTask', {
            userId: '123',
            workspace: 'hardhat',
            blockNumber: 1
        });
    });

    afterEach(() => helper.clean());
});

describe('syncFailedTransactionError', () => {
    beforeEach(() => {
        helper = new Helper(process.env.GCLOUD_PROJECT);
    });

    it('Should return a success flag', async () => {
        const wrapped = helper.test.wrap(index.syncFailedTransactionError);

        const data = {
            workspace: 'hardhat',
            transaction: Transaction.hash,
            error: { parsed: true, error: 'Helloooo' }
        };

        const result = await wrapped(data, auth);
        expect(result).toEqual({ success: true });
    });

    afterEach(() => helper.clean());
});

describe('processTransaction', () => {
    beforeEach(() => {
        helper = new Helper(process.env.GCLOUD_PROJECT);
    });

    it('Should return a success flag', async () => {
        const wrapped = helper.test.wrap(index.processTransaction);

        const data = {
            workspace: 'hardhat',
            transaction: Transaction.hash
        };

        const result = await wrapped(data, auth);
        expect(result).toEqual({ success: true });
    });

    afterEach(() => helper.clean());
});

describe('syncTokenBalanceChanges', () => {
    beforeEach(() => {
        helper = new Helper(process.env.GCLOUD_PROJECT);
    });

    it('Should return a success flag', async () => {
        const wrapped = helper.test.wrap(index.processTransaction);

        const data = {
            workspace: 'hardhat',
            transaction: Transaction.hash,
            tokenBalanceChanges: {
                '0xdc64a140aa3e981100a9beca4e685f962f0cf6c9': [
                    {
                        address: '0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266',
                        currentBalance: '99999999870000000000000000000',
                        previousBalance: '99999999880000000000000000000',
                        diff: '-10000000000000000000'
                    },
                    {
                        address: '0x2d481eeb2ba97955cd081cf218f453a817259ab1',
                        currentBalance: '130000000000000000000',
                        previousBalance: '120000000000000000000',
                        diff: '10000000000000000000'
                    }
                ]
            }
        };

        const result = await wrapped(data, auth);
        expect(result).toEqual({ success: true });
    });

    afterEach(() => helper.clean());
});

describe('getUnprocessedContracts', () => {
    beforeEach(() => {
        helper = new Helper(process.env.GCLOUD_PROJECT);
    });

    it('Should return contracts not marked as processed', async () => {
        await helper.workspace
                .collection('contracts')
                .doc('0x12356')
                .set({ abi: 'abi' });

        await helper.workspace
                .collection('contracts')
                .doc('0x124')
                .set({ abi: 'abi', processed: true });

        const wrapped = helper.test.wrap(index.getUnprocessedContracts);
        const result = await wrapped({ workspace: 'hardhat' }, auth);

        expect(result).toEqual({
            contracts: [{ abi: 'abi' }]
        });
    });

    afterEach(() => helper.clean());
});

describe('setTokenProperties', () => {
    beforeEach(() => {
        helper = new Helper(process.env.GCLOUD_PROJECT);
        return helper.workspace
            .collection('contracts')
            .doc('0x123')
            .set({ abi: 'abi' });
    });

    it('Should set token patterns that are passed', async () => {
        const wrapped = helper.test.wrap(index.setTokenProperties);
        const result = await wrapped({ workspace: 'hardhat', contract: '0x123', tokenPatterns: ['erc20'] }, auth);

        const contractRef = await helper.workspace.collection('contracts').doc('0x123').get();

        expect(storeContractData).toHaveBeenCalledWith('123', 'hardhat', '0x123', {
            patterns: expect.anything(),
            processed: true,
            token: {}
        });
        expect(result).toEqual({ success: true });
    });

    it('Should set token properties that are passed', async () => {
        const wrapped = helper.test.wrap(index.setTokenProperties);
        const result = await wrapped({ workspace: 'hardhat', contract: '0x123', tokenProperties: { symbol: 'ETL', decimals: 18, name: 'Ethernal' }}, auth);

        const contractRef = await helper.workspace.collection('contracts').doc('0x123').get();

        expect(storeContractData).toHaveBeenCalledWith('123', 'hardhat', '0x123', {
            patterns: [],
            processed: true,
            token: { symbol: 'ETL', decimals: 18, name: 'Ethernal' }
        });
        expect(result).toEqual({ success: true });
    });

    afterEach(() => helper.clean());
});

describe('resetWorkspace', () => {
    beforeEach(() => {
        helper = new Helper(process.env.GCLOUD_PROJECT);
    });

    it('Should remove accounts/blocks/contracts/transactions from firestore', async () => {
        await helper.workspace.collection('accounts').doc('0x123').set({ address: '0x123' });
        await helper.workspace.collection('blocks').doc('0xabc').set({ number: '1' });
        await helper.workspace.collection('contracts').doc('0x456').set({ address: '0x456' });
        await helper.workspace.collection('transactions').doc('0x789').set({ hash: '0x789' });
        await helper.database.ref('/users/123/workspaces/hardhat/contracts/0x123').set({ a: 3});

        const wrapped = helper.test.wrap(index.resetWorkspace);
        const result = await wrapped({ workspace: 'hardhat' }, auth);
        
        const accountsSnap = await helper.workspace.collection('accounts').get();
        const blocksSnap = await helper.workspace.collection('blocks').get();
        const contractsSnap = await helper.workspace.collection('contracts').get();
        const transactionsSnap = await helper.workspace.collection('transactions').get();
        const contractDbSnap = await helper.database.ref('/users/123/workspaces/hardhat/contracts/0x123').once('value');

        expect(accountsSnap.size).toBe(0);
        expect(blocksSnap.size).toBe(0);
        expect(contractsSnap.size).toBe(0);
        expect(transactionsSnap.size).toBe(0);
        expect(contractDbSnap.val()).toBe(null);
    });

    afterEach(async () => {
        await helper.clean();
    })
});

describe('syncBlock', () => {
    beforeEach(() => {
        helper = new Helper(process.env.GCLOUD_PROJECT);
    });

    it('Should bill when no tx', async () => {
        const wrapped = helper.test.wrap(index.syncBlock);
        const block = {
            number: '123',
            value: null,
            transactions: []
        };
        
        const result = await wrapped({ block: block, workspace: 'hardhat' }, auth);
        expect(pubSubMockInstance.publish.callCount).toEqual(1);
    });

    it('Should return the synced block number', async () => {
        const wrapped = helper.test.wrap(index.syncBlock);
        const block = {
            number: '123',
            value: null,
            transactions: []
        };
        
        const result = await wrapped({ block: block, workspace: 'hardhat' }, auth);
        expect(result).toEqual({ blockNumber: '123' });
    });

    it('Should not bill the block if there is a tx', async () => {
        const wrapped = helper.test.wrap(index.syncBlock);
        const block = {
            number: '123',
            value: null,
            transactions: [{ hash: '0x1234' }]
        };

        const result = await wrapped({ block: block, workspace: 'hardhat' }, auth);        
        expect(pubSubMockInstance.publish.callCount).toEqual(0);
    });

    afterEach(async () => {
        await helper.clean();
    });
});

describe('syncContractArtifact', () => {
    let contractArtifact;

    beforeEach(async () => {
        helper = new Helper(process.env.GCLOUD_PROJECT);
        await helper.setUser();
        const AmalfiContract = require('./fixtures/AmalfiContract.json');
        contractArtifact = JSON.stringify(AmalfiContract.artifact);
    });

    it('Should store the contract artifact in rtdb', async () => {
        const wrapped = helper.test.wrap(index.syncContractArtifact);
        const data = {
            workspace: 'hardhat',
            address: '0x123',
            artifact: contractArtifact
        };

        const result = await wrapped(data, auth);
        expect(storeContractArtifact).toHaveBeenCalledWith('123', 'hardhat', '0x123', contractArtifact);
    });

    it('Should not store more than 10 contracts on a free plan', async () => {
        canUserSyncContract.mockResolvedValue(false);
        const wrapped = helper.test.wrap(index.syncContractArtifact);
        const data = {
            workspace: 'hardhat',
            address: '0x222',
            artifact: contractArtifact
        };

        await expect(async () => {
            await wrapped(data, auth);
            expect(storeContractArtifact).not.toHaveBeenCalled();
        }).rejects.toThrow({ message: 'Free plan users are limited to 10 synced contracts. Upgrade to our Premium plan to sync more.' });
    });

    it('Should store more than 10 contracts on a premium plan', async () => {
        canUserSyncContract.mockResolvedValue(true);

        const wrapped = helper.test.wrap(index.syncContractArtifact);
        const data = {
            workspace: 'hardhat',
            address: '0x222',
            artifact: contractArtifact
        };

        const result = await wrapped(data, auth);
        expect(storeContractArtifact).toHaveBeenCalledWith('123', 'hardhat', '0x222', contractArtifact);
    });

    it('Should allow updating an artifact of a contract that already exists even with more than 10 contracts on a free plan', async () => {
        for (let i = 0; i < 10; i++) {
            await helper.firestore
                .collection('users')
                .doc('123')
                .collection('workspaces')
                .doc('hardhat')
                .collection('contracts')
                .doc(`0x12${i}`)
                .set({ artifact: 'artifact' });
        }

        const wrapped = helper.test.wrap(index.syncContractArtifact);
        const data = {
            workspace: 'hardhat',
            address: '0x120',
            artifact: contractArtifact
        };

        const result = await wrapped(data, auth);
        expect(result).toEqual({ address: '0x120' });
    });

    afterEach(async () => {
        await helper.clean();
    });
});

describe('syncContractDependencies', () => {
    let contractArtifact;

    beforeEach(async () => {
        helper = new Helper(process.env.GCLOUD_PROJECT);
        await helper.setUser();
        const AmalfiContract = require('./fixtures/AmalfiContract.json');
        contractDependency = JSON.stringify(AmalfiContract.dependencies['Address']);
    });

    it('Should store the contract dependencies in the database', async () => {
        const wrapped = helper.test.wrap(index.syncContractDependencies);
        const data = {
            workspace: 'hardhat',
            address: '0x123',
            dependencies: { Address: contractDependency }
        };

        const result = await wrapped(data, auth);
        expect(storeContractDependencies).toHaveBeenCalledWith('123', 'hardhat', '0x123', { Address: contractDependency });
    });

    it('Should not store more than 10 contracts on a free plan', async () => {
        canUserSyncContract.mockResolvedValue(false);
        const wrapped = helper.test.wrap(index.syncContractDependencies);
        const data = {
            workspace: 'hardhat',
            address: '0x222',
            dependencies: { Address: contractDependency }
        };

        await expect(async () => {
            await wrapped(data, auth);
            expect(storeContractDependencies).not.toHaveBeenCalled();
        }).rejects.toThrow({ message: 'Free plan users are limited to 10 synced contracts. Upgrade to our Premium plan to sync more.' });
    });

    it('Should store more than 10 contracts on a premium plan', async () => {
        canUserSyncContract.mockResolvedValue(true);
        const wrapped = helper.test.wrap(index.syncContractDependencies);
        const data = {
            workspace: 'hardhat',
            address: '0x222',
            dependencies: { Address: contractDependency }
        };

        const result = await wrapped(data, auth);
        expect(storeContractDependencies).toHaveBeenCalledWith('123', 'hardhat', '0x222', { Address: contractDependency });
    });

    it('Should allow updating a dependency of a contract that already exists even with more than 10 contracts on a free plan', async () => {
        canUserSyncContract.mockResolvedValue(false);
        getContractData.mockResolvedValue({ address: '0x120' });
        const wrapped = helper.test.wrap(index.syncContractDependencies);
        const data = {
            workspace: 'hardhat',
            address: '0x120',
            dependencies: { Address: contractDependency }
        };

        const result = await wrapped(data, auth);
        expect(storeContractDependencies).toHaveBeenCalledWith('123', 'hardhat', '0x120', { Address: contractDependency });
    });

    afterEach(async () => {
        await helper.clean();
    });
});

describe('syncTrace', () => {
    beforeEach(async () => {
        helper = new Helper(process.env.GCLOUD_PROJECT);
        await helper.setUser({ plan: 'premium' });
    });

    it('Should store a filtered trace', async () => {
        const wrapped = helper.test.wrap(index.syncTrace);

        const data = {
            workspace: 'hardhat',
            txHash: '0x123',
            steps: Trace
        };

        const result = await wrapped(data, auth);
        expect(storeTrace).toHaveBeenCalledWith('123', 'hardhat', '0x123', Trace);
    });

    afterEach(async () => {
        await helper.clean();
    });
});

describe('syncContractData', () => {
    beforeEach(async () => {
        helper = new Helper(process.env.GCLOUD_PROJECT);
        await helper.setUser();
    });

    it('Should store contract data', async () => {
        const wrapped = helper.test.wrap(index.syncContractData);

        const data = {
            workspace: 'hardhat',
            address: '0x123',
            name: 'Contract',
            abi: { my: 'function' }
        };

        const result = await wrapped(data, auth);

        expect(storeContractData).toHaveBeenCalledWith('123', 'hardhat', '0x123', {
            address: '0x123',
            name: 'Contract',
            abi: { my: 'function' }
        });
    });

    it('Should not store more than 10 contracts on a free plan', async () => {
        getContractData.mockResolvedValue(null);
        canUserSyncContract.mockResolvedValue(false);

        const wrapped = helper.test.wrap(index.syncContractData);
        const data = {
            workspace: 'hardhat',
            address: '0x222',
            name: 'test',
            abi: { abi: 'abi' }
        };

        await expect(async () => {
            await wrapped(data, auth);
        }).rejects.toThrow({ message: 'Free plan users are limited to 10 synced contracts. Upgrade to our Premium plan to sync more.' });
        expect(storeContractData).not.toHaveBeenCalled();
    });

    it('Should store more than 10 contracts on a premium plan', async () => {
        canUserSyncContract.mockResolvedValue(true);

        const wrapped = helper.test.wrap(index.syncContractData);
        const data = {
            workspace: 'hardhat',
            address: '0x123',
            name: 'test',
            abi: { abi: 'abi' }
        };

        const result = await wrapped(data, auth);
        expect(storeContractData).toHaveBeenCalledWith('123', 'hardhat', '0x123', {
            address: '0x123',
            name: 'test',
            abi: { abi: 'abi' }
        });
    });

    it('Should allow updating a contract that already exists even with more than 10 contracts on a free plan', async () => {
        canUserSyncContract.mockResolvedValue(true);
        getContractData.mockResolvedValue({ address: '0x120' });

        const wrapped = helper.test.wrap(index.syncContractData);
        const data = {
            workspace: 'hardhat',
            address: '0x120',
            name: 'test',
            abi: { my: 'abi' }
        };

        const result = await wrapped(data, auth);
        expect(storeContractData).toHaveBeenCalledWith('123', 'hardhat', '0x120', {
            address: '0x120',
            name: 'test',
            abi: { my: 'abi' }
        });
    });

    afterEach(async () => {
        await helper.clean();
    });
});

describe('syncTransaction', () => {
    beforeEach(async () => {
        helper = new Helper(process.env.GCLOUD_PROJECT);
        await helper.setUser();
    });

    it('Should store the transaction and return the hash', async () => {
        const wrapped = helper.test.wrap(index.syncTransaction);

        const data = {
            workspace: 'hardhat',
            transaction: Transaction,
            block: Block
        };

        const result = await wrapped(data, auth);

        expect(result).toEqual({ txHash: Transaction.hash });
        expect(pubSubMockInstance.publish.callCount).toEqual(1);
        expect(storeTransaction).toHaveBeenCalledWith(
            '123',
            'hardhat',
            expect.anything()
        );
    });

    it('Should store the transaction & receipt, decode function signature, and return the hash', async () => {
        const wrapped = helper.test.wrap(index.syncTransaction);

        const data = {
            workspace: 'hardhat',
            transaction: Transaction,
            transactionReceipt: TransactionReceipt,
            block: Block
        };

        const result = await wrapped(data, auth);
        expect(processTransactions).toHaveBeenCalledWith('123', 'hardhat', [{
            ...Transaction,
            receipt: TransactionReceipt,
            timestamp: Block.timestamp.toString(),
            error: '',
            tokenTransfers: [],
            tokenBalanceChanges: {}
        }]);
        expect(result).toEqual({ txHash: Transaction.hash });
    });

    it('Should not break if there is an error during transaction processing', async () => {
        getContractData.mockRejectedValue('error');

        const wrapped = helper.test.wrap(index.syncTransaction);

        const data = {
            workspace: 'hardhat',
            transaction: Transaction,
            transactionReceipt: TransactionReceipt,
            block: Block
        };

        const result = await wrapped(data, auth);
        expect(result).toEqual({ txHash: Transaction.hash });
    });

    it('Should create the contract locally if there no to field', async () => {
        const wrapped = helper.test.wrap(index.syncTransaction);

        const { to, ...creationTransaction } = Transaction;

        const data = {
            workspace: 'hardhat',
            transaction: creationTransaction,
            transactionReceipt: { ...TransactionReceipt, contractAddress: to },
            block: Block
        };

        const result = await wrapped(data, auth);

        expect(storeContractData).toHaveBeenCalledWith('123', 'hardhat', to, { address: to, timestamp: Block.timestamp });
        expect(result).toEqual({ txHash: Transaction.hash });
    });

    it('Should not store more than 10 contracts on a free plan', async () => {
        canUserSyncContract.mockResolvedValue(false);

        const wrapped = helper.test.wrap(index.syncTransaction);
        const { to, ...creationTransaction } = Transaction;

        const data = {
            workspace: 'hardhat',
            transaction: creationTransaction,
            transactionReceipt: { ...TransactionReceipt, contractAddress: to },
            block: Block
        };

        const result = await wrapped(data, auth);

        expect(storeContractData).not.toHaveBeenCalled();
    });

    it('Should store more than 10 contracts on a premium plan', async () => {
        canUserSyncContract.mockResolvedValue(true);

        const wrapped = helper.test.wrap(index.syncTransaction);
        const { to, ...creationTransaction } = Transaction;

        const data = {
            workspace: 'hardhat',
            transaction: creationTransaction,
            transactionReceipt: { ...TransactionReceipt, contractAddress: to },
            block: Block
        };

        const result = await wrapped(data, auth);

        expect(storeContractData).toHaveBeenCalled();
    });

    afterEach(async () => {
        await helper.clean();
    });
});

describe('enableAlchemyWebhook', () => {
    beforeEach(async () => {
        helper = new Helper(process.env.GCLOUD_PROJECT);
        await helper.firestore
            .collection('users')
            .doc('123')
            .set({ apiKey: 'c51be5b4afd6f008f536611b2c1bf47d:8e167c103709c4238995cefae6975a366e150583cdf9c963de44913aa3f84438' }, { merge: true });

        await helper.workspace.set({ localNetwork: true }, { merge: true });

        getUser.mockResolvedValue({
            data: () => {
                return {
                    apiKey: 'c51be5b4afd6f008f536611b2c1bf47d:8e167c103709c4238995cefae6975a366e150583cdf9c963de44913aa3f84438'
                }
            }
        });
    });

    it('Should enable the integration and return the token', async () => {
        const wrapped = helper.test.wrap(index.enableAlchemyWebhook);

        const data = {
            workspace: 'hardhat'
        };

        const result = await wrapped(data, auth);

        expect(result.token).toBeTruthy();
    });

    it('Should update the workspace', async () => {
        const wrapped = helper.test.wrap(index.enableAlchemyWebhook);

        const data = {
            workspace: 'hardhat'
        };

        await wrapped(data, auth);

        const wsRef = await helper.workspace.get();

        expect(wsRef.data()).toEqual({ localNetwork: true, settings: { integrations: ['alchemy'] } });
    });

    afterEach(async () => {
        await helper.clean();
    });
});

describe('enableWorkspaceApi', () => {
    beforeEach(async () => {
        helper = new Helper(process.env.GCLOUD_PROJECT);
        await helper.firestore
            .collection('users')
            .doc('123')
            .set({ apiKey: 'c51be5b4afd6f008f536611b2c1bf47d:8e167c103709c4238995cefae6975a366e150583cdf9c963de44913aa3f84438' }, { merge: true });

        await helper.workspace.set({ localNetwork: true }, { merge: true });

        getUser.mockResolvedValue({
            data: () => {
                return {
                    apiKey: 'c51be5b4afd6f008f536611b2c1bf47d:8e167c103709c4238995cefae6975a366e150583cdf9c963de44913aa3f84438'
                }
            }
        });
    });

    it('Should enable the api and return the token', async () => {
        const wrapped = helper.test.wrap(index.enableWorkspaceApi);

        const data = {
            workspace: 'hardhat'
        };

        const result = await wrapped(data, auth);

        expect(result.token).toBeTruthy();
    });

    it('Should update the workspace', async () => {
        const wrapped = helper.test.wrap(index.enableWorkspaceApi);

        const data = {
            workspace: 'hardhat'
        };

        await wrapped(data, auth);

        const wsRef = await helper.workspace.get();

        expect(wsRef.data()).toEqual({ localNetwork: true, settings: { integrations: ['api'] } });
    });

    afterEach(async () => {
        await helper.clean();
    });
});

describe('getWorkspaceApiToken', () => {
    beforeEach(async () => {
        helper = new Helper(process.env.GCLOUD_PROJECT);
        await helper.firestore
            .collection('users')
            .doc('123')
            .set({ apiKey: 'c51be5b4afd6f008f536611b2c1bf47d:8e167c103709c4238995cefae6975a366e150583cdf9c963de44913aa3f84438' }, { merge: true });

        await helper.workspace.set({ localNetwork: true }, { merge: true });

        getUser.mockResolvedValue({
            data: () => {
                return {
                    apiKey: 'c51be5b4afd6f008f536611b2c1bf47d:8e167c103709c4238995cefae6975a366e150583cdf9c963de44913aa3f84438'
                }
            }
        });
    });

    it('Should return the token', async () => {
         const wrapped = helper.test.wrap(index.getWorkspaceApiToken);

        const data = {
            workspace: 'hardhat'
        };

        const result = await wrapped(data, auth);

        expect(result.token).toBeTruthy();
    });

    afterEach(async () => {
        await helper.clean();
    });
});

describe('disableAlchemyWebhook', () => {
    beforeEach(async () => {
        helper = new Helper(process.env.GCLOUD_PROJECT);
        await helper.firestore
            .collection('users')
            .doc('123')
            .set({ apiKey: 'c51be5b4afd6f008f536611b2c1bf47d:8e167c103709c4238995cefae6975a366e150583cdf9c963de44913aa3f84438' }, { merge: true });

        await helper.workspace.set({ localNetwork: true }, { merge: true });
    });

    it('Should update the workspace', async () => {
        const wrapped = helper.test.wrap(index.disableAlchemyWebhook);

        const data = {
            workspace: 'hardhat'
        };

        await wrapped(data, auth);

        const userRef = await helper.workspace.get();

        expect(userRef.data()).toEqual({ localNetwork: true, settings: { integrations: [] } });
    });

    afterEach(async () => {
        await helper.clean();
    });
});

describe('disableWorkspaceApi', () => {
    beforeEach(async () => {
        helper = new Helper(process.env.GCLOUD_PROJECT);
        await helper.firestore
            .collection('users')
            .doc('123')
            .set({ apiKey: 'c51be5b4afd6f008f536611b2c1bf47d:8e167c103709c4238995cefae6975a366e150583cdf9c963de44913aa3f84438' }, { merge: true });

        await helper.workspace.set({ localNetwork: true }, { merge: true });
    });

    it('Should update the workspace', async () => {
        const wrapped = helper.test.wrap(index.disableWorkspaceApi);

        const data = {
            workspace: 'hardhat'
        };

        await wrapped(data, auth);

        const userRef = await helper.workspace.get();

        expect(userRef.data()).toEqual({ localNetwork: true, settings: { integrations: [] } });
    });

    afterEach(async () => {
        await helper.clean();
    });
});

describe('importContract', () => {
    beforeEach(async () => {
        helper = new Helper(process.env.GCLOUD_PROJECT);
    });

    it('Should create a document with the address and flag it as imported', async () => {
        const data = {
            workspace: 'hardhat',
            contractAddress: '0x123'
        };

        const wrapped = helper.test.wrap(index.importContract);

        const result = await wrapped(data, auth);

        expect(result).toEqual({ success: true });
        expect(storeContractData).toHaveBeenCalledWith('123', 'hardhat', '0x123', {
            address: '0x123',
            imported: true
        });
    });

    afterEach(async () => {
        await helper.clean();
    });    
});

describe('setPrivateKey', () => {
    beforeEach(async () => {
        helper = new Helper(process.env.GCLOUD_PROJECT);
        await helper.workspace
            .collection('accounts')
            .doc('0x123')
            .set({ address: '0x123' });
    });

    it('Should store the private key for a new user', async () => {
        const wrapped = helper.test.wrap(index.setPrivateKey);

        const data = {
            workspace: 'hardhat',
            account: '0x123',
            privateKey: 'abcdef'
        };

        const result = await wrapped(data, auth);

        const accountRef = await helper.workspace
            .collection('accounts')
            .doc('0x123')
            .get();

        expect(accountRef.data().privateKey).toBeTruthy();
        expect(accountRef.data().privateKey).not.toEqual('abcdef');
        expect(result).toEqual({ success: true });
    });

    afterEach(async () => {
        await helper.clean();
    });    
});

describe('getAccount', () => {
    beforeEach(async () => {
        helper = new Helper(process.env.GCLOUD_PROJECT);
    });

    it('Should return the account with a decrypted key', async () => {
        await helper.workspace
            .collection('accounts')
            .doc('0x123')
            .set({ address: '0x123', balance: '1000', privateKey: 'c51be5b4afd6f008f536611b2c1bf47d:8e167c103709c4238995cefae6975a366e150583cdf9c963de44913aa3f84438' });
        
        const wrapped = helper.test.wrap(index.getAccount);

        const data = {
            workspace: 'hardhat',
            account: '0x123'
        };

        const result = await wrapped(data, auth);

        expect(result).toEqual({ address: '0x123', balance: '1000', privateKey: 'GT8P7FD-R2M4SCG-GPCYE58-8FC1969' })
    });

    it('Should return an account without a key', async () => {
        await helper.workspace
            .collection('accounts')
            .doc('0x123')
            .set({ address: '0x123', balance: '1000' });

        const wrapped = helper.test.wrap(index.getAccount);

        const data = {
            workspace: 'hardhat',
            account: '0x123'
        };

        const result = await wrapped(data, auth);

        expect(result).toEqual({ address: '0x123', balance: '1000' });
    });

    afterEach(async () => {
        await helper.clean();
    });
});

describe('createWorkspace', () => {
    beforeEach(async () => {
        helper = new Helper(process.env.GCLOUD_PROJECT);
        await helper.setUser();
    });

    it('Should create a new workspace', async () => {
        await helper.setUser({ plan: 'premium' });
        const wrapped = helper.test.wrap(index.createWorkspace);

        const data = {
            name: 'Ganache',
            workspaceData: {
                chain: 'ethereum',
                rpcServer: 'http://localhost:8545',
                networkId: 1,
                settings: {
                    gasLimit: 1000,
                    defaultAccount: '0x123'
                }
            }
        };

        const result = await wrapped(data, auth);

        const wsRef = await helper.firestore
            .collection('users')
            .doc('123')
            .collection('workspaces')
            .doc('Ganache')
            .get();

        expect(wsRef.data()).toEqual(data.workspaceData);
        expect(result).toEqual({ success: true });
    });

    it('Should not create a second workspace for free plan users', async() => {
        await helper.firestore
            .collection('users')
            .doc('123')
            .collection('workspaces')
            .doc('hardhat')
            .set({ name: 'Hardhat' });

        const wrapped = helper.test.wrap(index.createWorkspace);

        const data = {
            name: 'Ganache',
            workspaceData: {
                rpcServer: 'http://localhost:8545',
                networkId: 1,
                settings: {
                    gasLimit: 1000,
                    defaultAccount: '0x123'
                }
            }
        };

        await expect(async () => {
            await wrapped(data, auth);
        }).rejects.toThrow({ message: 'Free plan users are limited to one workspace. Upgrade to our Premium plan to create more.' });
    })
});

describe('setCurrentWorkspace', () => {
    beforeEach(async () => {
        helper = new Helper(process.env.GCLOUD_PROJECT);
        await helper.setUser();
    });

    it('Should update the default workspace', async () => {
        const firestoreConverter = async (snapshot, options) => {
            const data = snapshot.data(options);
            const workspace = (await data.currentWorkspace.get()).data();
            Object.defineProperty(data, 'currentWorkspace', { value: workspace });
            return data;
        };
        await helper.firestore
            .collection('users')
            .doc('123')
            .collection('workspaces')
            .doc('Ganache')
            .set({ rpcServer: 'http://localhost:7545' });

        const wrapped = helper.test.wrap(index.setCurrentWorkspace);

        const data = {
            name: 'Ganache'
        };

        const result = await wrapped(data, auth);

        const userRef = await helper.firestore
            .collection('users')
            .doc('123')
            .withConverter({ fromFirestore: firestoreConverter })
            .get();

        expect(await userRef.data()).toEqual({ currentWorkspace: { rpcServer: 'http://localhost:7545' }, plan: 'free' });
        expect(result).toEqual({ success: true });
    });

    afterEach(async () => {
        await helper.clean();
    });
});

describe('syncBalance', () => {
    beforeEach(async () => {
        helper = new Helper(process.env.GCLOUD_PROJECT);
    });

    it('Should update the account balance', async () => {
        await helper.workspace
            .collection('accounts')
            .doc('0x123')
            .set({ balance: '1234' });

        const wrapped = helper.test.wrap(index.syncBalance);

        const data = {
            workspace: 'hardhat',
            account: '0x123',
            balance: '1000000'
        };

        const result = await wrapped(data, auth);

        const accountRef = await helper.workspace
            .collection('accounts')
            .doc('0x123')
            .get();

        expect(accountRef.data()).toEqual({ balance: '1000000' });
        expect(result).toEqual({ success: true });
    });

    afterEach(async () => {
        await helper.clean();
    });
});

describe('updateWorkspaceSettings', () => {
    beforeEach(async () => {
        helper = new Helper(process.env.GCLOUD_PROJECT);
        await helper.workspace
            .set({
                chain: 'ethereum',
                settings: {
                    defaultAccount: '0x123',
                    gasLimit: '1000',
                    gasPrice: '1'
                },
                advancedOptions: {
                    tracing: 'disabled'
                }
            });
    });

    it('Should allow advanced options update', async () => {
        const wrapped = helper.test.wrap(index.updateWorkspaceSettings);

        const data = {
            workspace: 'hardhat',
            settings: {
                advancedOptions: {
                    tracing: 'hardhat'
                }
            }
        };

        const result = await wrapped(data, auth);

        const wsRef = await helper.workspace.get();

        expect(result).toEqual({ success: true });
        expect(wsRef.data()).toEqual({
            chain: 'ethereum',
            settings: {
                defaultAccount: '0x123',
                gasLimit: '1000',
                gasPrice: '1'
            },
            advancedOptions: {
                tracing: 'hardhat'
            }
        });
    });

    it('Should allow chain update', async () => {
        const wrapped = helper.test.wrap(index.updateWorkspaceSettings);

        const data = {
            workspace: 'hardhat',
            settings: {
                chain: 'matic'
            }
        };

        const result = await wrapped(data, auth);

        const wsRef = await helper.workspace.get();

        expect(result).toEqual({ success: true });
        expect(wsRef.data()).toEqual({
            chain: 'matic',
            settings: {
                defaultAccount: '0x123',
                gasLimit: '1000',
                gasPrice: '1'
            },
            advancedOptions: {
                tracing: 'disabled'
            }
        });
    });

    it('Should allow settings update', async () => {
        const wrapped = helper.test.wrap(index.updateWorkspaceSettings);

        const data = {
            workspace: 'hardhat',
            settings: {
                settings : {
                    defaultAccount: '0x124',
                    gasLimit: '2000',
                    gasPrice: '2'
                }
            }
        };

        const result = await wrapped(data, auth);

        const wsRef = await helper.workspace.get();

        expect(result).toEqual({ success: true });
        expect(wsRef.data()).toEqual({
            chain: 'ethereum',
            settings: {
                defaultAccount: '0x124',
                gasLimit: '2000',
                gasPrice: '2'
            },
            advancedOptions: {
                tracing: 'disabled'
            }
        });
    });

    it('Should prevent updating a non-whitelisted setting', async () => {
        const wrapped = helper.test.wrap(index.updateWorkspaceSettings);

        const data = {
            workspace: 'hardhat',
            settings: {
                settings : {
                    thing: 'no'
                }
            }
        };

        const result = await wrapped(data, auth);

        const wsRef = await helper.workspace.get();

        expect(result).toEqual({ success: true });
        expect(wsRef.data()).toEqual({
            chain: 'ethereum',
            settings : {
                defaultAccount: '0x123',
                gasLimit: '1000',
                gasPrice: '1'
            },
            advancedOptions: {
                tracing: 'disabled'
            }
        });
    });

    it('Should prevent updating a non-whitelisted advanced option', async () => {
        const wrapped = helper.test.wrap(index.updateWorkspaceSettings);

        const data = {
            workspace: 'hardhat',
            settings: {
                advancedOptions: {
                    thisis: 'notavalidoption'
                }
            }
        };

        const result = await wrapped(data, auth);

        const wsRef = await helper.workspace.get();

        expect(result).toEqual({ success: true });
        expect(wsRef.data()).toEqual({
            chain: 'ethereum',
            settings: {
                defaultAccount: '0x123',
                gasLimit: '1000',
                gasPrice: '1'
            },
            advancedOptions: {
                tracing: 'disabled'
            }
        });
    });

    afterEach(async () => {
        await helper.clean();
    });
});

describe('createStripeCheckoutSession', () => {
    beforeEach(async () => {
        helper = new Helper(process.env.GCLOUD_PROJECT);
        await helper.setUser();
    });

    it('Should return a Stripe Checkout url', async () => {
        const wrapped = helper.test.wrap(index.createStripeCheckoutSession);

        const data = {
            plan: 'premium'
        };

        const result = await wrapped(data, auth);

        expect(result).toEqual({ url: expect.stringContaining('https://checkout.stripe.com/pay') })
    });

    it('Should fail if an invalid plan is requested', async () => {
        const wrapped = helper.test.wrap(index.createStripeCheckoutSession);

        const data = {
            plan: 'megapremium'
        };

        await expect(async () => {
            await wrapped(data, auth);
        }).rejects.toThrow({ message: '[createStripeCheckoutSession] Invalid plan.' });
    });

    afterEach(async () => {
        await helper.clean();
    });
});

describe('createStripePortalSession', () => {
    beforeEach(() => {
        helper = new Helper(process.env.GCLOUD_PROJECT);
    });

    it('Should return a Stripe portal url', async () => {
        await helper.setUser({ plan: 'premium', stripeCustomerId: 'cus_1234' });

        const wrapped = helper.test.wrap(index.createStripePortalSession);

        const result = await wrapped({}, auth);

        expect(result).toEqual({ url: expect.stringContaining('https://billing.stripe.com/session') });
    });

    afterEach(async () => {
        await helper.clean();
    });
});

describe('removeContract', () => {
    beforeEach(() => {
        helper = new Helper(process.env.GCLOUD_PROJECT);
    });

    it('Should remove the contract & its metadata if it exists', async () => {
        await helper.workspace
            .collection('contracts')
            .doc('0x123')
            .set({ name:' contract' });
        await helper.database.ref('/users/123/workspaces/hardhat/contracts/0x123').set({ a: 3});

        const wrapped = helper.test.wrap(index.removeContract);
        
        const data = {
            workspace: 'hardhat',
            address: '0x123'
        };

        const result = await wrapped(data, auth);

        expect(result).toEqual({ success: true });

        const contractRef = await helper.workspace
            .collection('contracts')
            .doc('0x123')
            .get();
        expect(contractRef.exists).toBe(false);

        const contractDbSnap = await helper.database.ref('/users/123/workspaces/hardhat/contracts/0x123').once('value');
        expect(contractDbSnap.val()).toBe(null);
    });

    it('Should do not fail if the contract does not exist', async () => {
        const wrapped = helper.test.wrap(index.removeContract);
        
        const data = {
            workspace: 'hardhat',
            address: '0x123'
        };

        const result = await wrapped(data, auth);

        expect(result).toEqual({ success: true });

        const contractRef = await helper.workspace
            .collection('contracts')
            .doc('0x123')
            .get();

        expect(contractRef.exists).toBe(false);

        const contractDbSnap = await helper.database.ref('/users/123/workspaces/hardhat/contracts/0x123').once('value');
        expect(contractDbSnap.val()).toBe(null);
    });

    afterEach(async () => {
        await helper.clean();
    });
});