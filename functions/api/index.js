const Web3 = require('web3');
const functions = require("firebase-functions");
const express = require('express');
const bodyParser = require('body-parser')
const ethers = require('ethers');
const Decoder = require('@truffle/decoder');
const Storage = require('../lib/storage');
const stripe = require('stripe')(functions.config().stripe.secret_key);
const { sanitize, stringifyBns, isJson } = require('../lib/utils');
const { decrypt, decode, encrypt } = require('../lib/crypto');
const writeLog = require('../lib/writeLog');
const cls = require('cls-hooked');

let db, models, transactionsLib, stripeLib;
const psqlWrapper = async (cb, req, res, next) => {
    try {
        models = models || require('../models');
        db = db || require('../lib/firebase')(models);
        transactionsLib = transactionsLib || require('../lib/transactions')(db);
        stripeLib = stripeLib|| require('../lib/stripe')(db);

        return await cb(req, res, next);
    } catch(error) {
        writeLog({
            log: 'postgresLogs',
            functionName: 'api.index.psqlWrapper',
            message: (error.original && error.original.message) || error,
            detail: error.stack,
        });
    }
};

const app = express();
app.use(bodyParser.json({
    verify: function(req,res,buf) {
        var url = req.originalUrl;
        if (url.startsWith('/webhooks/stripe')) {
            req.rawBody = buf.toString()
        }
    }
}));

const authMiddleware = async function(req, res, next) {
    return await psqlWrapper(async () => {
        try {
            if (!req.query.token) {
                throw 'Missing auth token.';
            }

            const data = decode(req.query.token);

            if (!data.apiKey || !data.workspace || !data.uid) {
                throw 'Invalid auth token';
            }

            const user = await db.getUser(data.uid);

            if (!user || decrypt(user.apiKey) != data.apiKey) {
                throw new functions.https.HttpsError('unauthenticated', 'Failed authentication');
            }

            const workspace = await db.getWorkspaceByName(user.id, data.workspace);

            res.locals.uid = data.uid;
            res.locals.workspace = { rpcServer: workspace.rpcServer, name: workspace.name };
            res.locals.integrations = workspace.settings && workspace.settings.integrations ?
                workspace.settings.integrations :
                [];

            next();
        } catch(error) {
            console.log(error);
            res.status(401).json({ message: error });
        }
    }, req, res, next)
};

app.get('/contracts/:address/storage', authMiddleware, async (req, res) => {
    try {
        const workspace = res.locals.workspace;

        if (res.locals.integrations.indexOf('api') == -1)
            throw { status: 400, message: `API integration for workspace ${workspace.name} is disabled` };

        const uid = res.locals.uid;
        const rpcServer = new URL(workspace.rpcServer);
        const contractAddress = req.params.address.toLowerCase();
        const watchedPaths = req.query.watchedPaths;

        const contractData = await db.getContractData(uid, workspace.name, contractAddress);

        if (!contractData)
            throw { status: 400, message: `No contract at ${contractAddress} in workspace ${workspace.name}` };

        const contractArtifact = (await db.getContractArtifact(uid, workspace.name, contractAddress)).val();
        const contractDependencies = (await db.getContractArtifactDependencies(uid, workspace.name, contractAddress)).val();

        if (!contractArtifact) {
            throw { status: 400, message: `No artifact for contract at ${contractAddress} in ${workspace.name}` };
        }

        let provider;
        if (rpcServer.protocol == 'http:' || rpcServer.protocol == 'https:') {
            provider = Web3.providers.HttpProvider;
        }
        else if (rpcServer.protocol == 'ws:' || rpcServer.protocol == 'wss:') {
            provider = Web3.providers.WebsocketProvider;
        }

        const web3 = new Web3(new provider(workspace.rpcServer));
        const parsedArtifact = JSON.parse(contractArtifact);

        const dependenciesArtifact = contractDependencies ?
            Object.entries(contractDependencies).map(dep => JSON.parse(dep[1])) :
            [];

        const instanceDecoder = await Decoder.forArtifactAt(parsedArtifact, web3, contractAddress, dependenciesArtifact);
        const storage = new Storage(instanceDecoder);

        await storage.buildStructure();
        const paths = watchedPaths ?
            watchedPaths
                .map((path) => path.replace(/'/g, '"'))
                .filter(isJson)
                .map((path) => JSON.parse(path)) :
            [];

        await storage.watch(paths);

        const decoded = await storage.decodeData();

        res.send({
            paths: paths,
            storage: decoded
        });
    } catch(error) {
        console.log(error);

        const message = error.message || (error.name == 'VariableNotFoundError' ?
            `Could not find variable ${error.nameOrId}` :
            error);

        res.status(error.status || 401).json({ message: message });
    }
});

app.post('/webhooks/alchemy', authMiddleware, async (req, res) => {
    return await psqlWrapper(async () => {
        try {
            if (!req.body.fullTransaction) {
                throw 'Missing transaction.';
            }

            const promises = [];
            const provider = new ethers.providers.JsonRpcProvider(res.locals.workspace.rpcServer);
            const transaction = await provider.getTransaction(req.body.fullTransaction.hash);

            const block = await provider.getBlock(transaction.blockHash);

            const blockData = stringifyBns(sanitize({
                hash: block.hash,
                parentHash: block.parentHash,
                number: block.number,
                timestamp: block.timestamp,
                nonce: block.nonce,
                difficulty: block.difficulty,
                gasLimit: block.gasLimit,
                gasUsed: block.gasUsed,
                miner: block.miner,
                extraData: block.extraData
            }));

            promises.push(db.storeBlock(res.locals.uid, res.locals.workspace.name, blockData));
            
            const transactionReceipt = await provider.getTransactionReceipt(transaction.hash);

            const txSynced = await transactionsLib.getTxSynced(res.locals.uid, res.locals.workspace.name, transaction, transactionReceipt, block.timestamp);

            promises.push(db.storeTransaction(res.locals.uid, res.locals.workspace.name, txSynced));

            if (!txSynced.to && transactionReceipt)
                promises.push(db.storeContractData(res.locals.uid, res.locals.workspace.name, transactionReceipt.contractAddress, { address: transactionReceipt.contractAddress }));

            await Promise.all(promises);

            res.send({ success: true });
        } catch(error) {
            console.log(error);
            res.status(401).json({ message: error });
        }
    }, req, res);
});

app.post('/webhooks/stripe', async (req, res) => {
    return await psqlWrapper(async () => {
        try {
            const sig = req.headers['stripe-signature'];
            const webhookSecret = functions.config().stripe.webhook_secret;
            let event;

            try {
                event = stripe.webhooks.constructEvent(req.rawBody, sig, webhookSecret);
            } catch (err) {
                throw err.message;
            }

            switch (event.type) {
                case 'invoice.payment_succeeded':
                    await stripeLib.handleStripePaymentSucceeded(event.data.object)
                    break;

                case 'customer.subscription.updated':
                    await stripeLib.handleStripeSubscriptionUpdate(event.data.object);
                    break;

                case 'customer.subscription.deleted':
                    await stripeLib.handleStripeSubscriptionDeletion(event.data.object);
                    break;
            }

            res.send({ success: true });
        } catch(error) {
            console.log(error);
            res.status(401).json({ message: error });
        }
    }, req, res);
});

module.exports = app;
