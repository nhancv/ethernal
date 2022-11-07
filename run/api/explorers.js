const express = require('express');
const router = express.Router();
const authMiddleware = require('../middlewares/auth');
const db = require('../lib/firebase');

router.post('/', authMiddleware, async (req, res) => {
    const data = req.body.data;
    try {
        if (!data.domain || !data.slug || !data.workspaceId || !data.chainId || !data.rpcServer || !data.theme)
            throw new Error('[POST /api/explorers] Missing parameters.');

        const user = await db.getUser(data.uid);
        const workspace = user.workspaces.find(w => w.id == data.workspaceId)

        if (!workspace)
            throw new Error('[POST /api/explorers] Could not find workspace.');

        const explorer = await db.createExplorer(
            user.id,
            workspace.id,
            data.chainId,
            data.name,
            data.rpcServer,
            data.slug,
            data.theme,
            data.totalSupply,
            data.domain,
            data.token
        );

        res.status(200).send(explorer);
    } catch(error) {
        console.log(error);
        console.log(data);
        res.status(400).send(error.message);
    }
});

router.get('/', async (req, res) => {
    const data = req.query;
    try {
        if (!data.domain && !data.slug)
            throw new Error('[GET /api/explorers] Missing parameters.');

        let explorer;

        if (data.domain)
            explorer = await db.getPublicExplorerParamsByDomain(data.domain);
        else
            explorer = await db.getPublicExplorerParamsBySlug(data.slug);

        if (explorer)
            res.status(200).json(explorer);
        else
            throw new Error('[GET /api/explorers] Could not find explorer');
    } catch(error) {
        console.log(error);
        console.log(data);
        res.status(400).send(error.message);
    }
});

module.exports = router;
