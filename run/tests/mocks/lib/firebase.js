jest.mock('../../../lib/firebase', () => {
    const { Workspace } = require('../models');
    return {
        getWorkspaceTransactions: jest.fn(),
        getWorkspaceTransaction: jest.fn(),
        storeTransactionData: jest.fn(),
        canUserSyncContract: jest.fn(),
        storeContractData: jest.fn(),
        storeTrace: jest.fn(),
        storeTokenBalanceChanges: jest.fn(),
        getTransaction: jest.fn(),
        storeFailedTransactionError: jest.fn(),
        storeTransaction: jest.fn(),
        storeBlock: jest.fn(),
        getWorkspaceBlock: jest.fn(),
        getWorkspaceBlocks: jest.fn(),
        resetWorkspace: jest.fn(),
        setCurrentWorkspace: jest.fn(),
        updateWorkspaceSettings: jest.fn(),
        createWorkspace: jest.fn(),
        addIntegration: jest.fn(),
        getUser: jest.fn(),
        removeIntegration: jest.fn(),
        updateAccountBalance: jest.fn(),
        storeAccountPrivateKey: jest.fn(),
        getAddressTransactions: jest.fn(),
        createUser: jest.fn(),
        getWorkspaceContracts: jest.fn(),
        getWorkspaceContract: jest.fn(),
        removeContract: jest.fn(),
        updateContractVerificationStatus: jest.fn(),
        getContractDeploymentTxByAddress: jest.fn(),
        getWorkspaceByName: jest.fn(),
        getContractData: jest.fn(),
        storeTokenBalanceChanges: jest.fn(),
        storeTransactionTokenTransfers: jest.fn(),
        getWorkspaceContractById: jest.fn(),
        getWorkspaceById: jest.fn(),
        getUserById: jest.fn(),
        getContractByHashedBytecode: jest.fn(),
        getContractTransactions: jest.fn(),
        getPublicExplorerParamsBySlug: jest.fn(),
        getContract: jest.fn(),
        getAccounts: jest.fn(),
        getFailedProcessableTransactions: jest.fn(),
        getProcessableTransactions: jest.fn(),
        getUserWorkspaces: jest.fn(),
        getUserbyStripeCustomerId: jest.fn(),
        updateUserPlan: jest.fn(),
        getPublicExplorerParamsByDomain: jest.fn(),
        getPublicExplorerParamsBySlug: jest.fn(),
        searchForNumber: jest.fn(),
        getAddressLatestTokenBalances: jest.fn(),
        getWalletVolume: jest.fn(),
        getTransactionVolume: jest.fn(),
        getTxCount: jest.fn(),
        getTotalTxCount: jest.fn(),
        getActiveWalletCount: jest.fn(),
        setWorkspaceRemoteFlag: jest.fn(),
        getContractErc721Tokens: jest.fn(),
        getContractErc721Token: jest.fn(),
        getErc721TokenTransfers: jest.fn(),
        storeErc721Token: jest.fn(),
        updateErc721Token: jest.fn(),
        getContractByWorkspaceId: jest.fn(),
        storeContractDataWithWorkspaceId: jest.fn(),
        getUnprocessedContracts: jest.fn(),
        getContractLogs: jest.fn(),
        getTokenTransferForProcessing: jest.fn(),
        getAddressStats: jest.fn(),
        getAddressTokenTransfers: jest.fn(),
        getTokenHolderHistory: jest.fn(),
        getTokenCumulativeSupply: jest.fn(),
        getTokenTransferVolume: jest.fn(),
        getTokenHolders: jest.fn(),
        getTokenTransfers: jest.fn(),
        getTokenStats: jest.fn(),
        getTransactionTokenTransfers: jest.fn(),
        Workspace: Workspace
    }
});
