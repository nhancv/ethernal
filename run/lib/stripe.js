const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const moment = require('moment');
const { sanitize } = require('./utils');
const Analytics = require('./analytics');
const db = require('./firebase');
const models = require('../models');
const analytics = new Analytics(process.env.MIXPANEL_API_TOKEN);

const deleteExplorerSubscription = async (stripeSubscription) => {
    if (stripeSubscription.status != 'canceled')
        return;

    const explorerId = stripeSubscription.metadata.explorerId;

    const user = await db.getUserbyStripeCustomerId(stripeSubscription.customer);
    const explorer = await db.getExplorerById(user.id, explorerId);

    if (!explorer || !explorer.stripeSubscription || explorer.stripeSubscription.stripeId != stripeSubscription.id)
        return;

    await db.deleteExplorerSubscription(user.id, explorerId, stripeSubscription.id);
}

const updateExplorerSubscription = async (stripeSubscription) => {
    const explorerId = stripeSubscription.metadata.explorerId;

    const user = await db.getUserbyStripeCustomerId(stripeSubscription.customer);
    const explorer = await db.getExplorerById(user.id, explorerId);

    if (!explorer)
        return;

    if (stripeSubscription.cancel_at_period_end == true) {
        return await db.cancelExplorerSubscription(user.id, explorerId);
    }

    const priceId = stripeSubscription.items.data[0].price.id;
    const stripePlan = await models.StripePlan.findOne({ where: { stripePriceId: priceId }});

    if (explorer.stripeSubscription)
        await db.updateExplorerSubscription(user.id, explorerId, stripePlan.id);
    else
        await db.createExplorerSubscription(user.id, explorerId, stripePlan.id, stripeSubscription.id, new Date(stripeSubscription.current_period_end * 1000));
}

const updatePlan = async (stripeSubscription) => {
    const user = await db.getUserbyStripeCustomerId(stripeSubscription.customer);

    if (!user)
        throw new Error("Couldn't find user.");

    let plan;

    switch (stripeSubscription.status) {
        case 'active':
            plan = 'premium';
            break;
        case 'canceled':
            plan = 'free';
            break;
        default:
            plan = 'free';
    }

    if (plan) {
        await db.updateUserPlan(user.firebaseUserId, plan);
        analytics.track(user.id, 'Subscription Change', {
            plan: plan,
            subscriptionStatus: stripeSubscription.status,
            cancelAtPeriodEnd: stripeSubscription.cancel_at_period_end
        });
        analytics.setSubscription(user.id, stripeSubscription.status, plan, stripeSubscription.cancel_at_period_end);
        return true;
    }
    else
        throw new Error("Couldn't update plan.");
}

module.exports = {
    handleStripeSubscriptionUpdate: async (data) => {
        if (data.metadata.explorerId)
            await updateExplorerSubscription(data);
        else
            await updatePlan(data);
    },

    handleStripeSubscriptionDeletion: async (data) => {
        if (data.metadata.explorerId)
            await deleteExplorerSubscription(data);
        else
            await updatePlan(data);
    },

    handleStripePaymentSucceeded: async (data) => {
        if (data.billing_reason == 'subscription_create') {
            const subscriptionId = data.subscription;
            const paymentIntentId = data.payment_intent;
            let subscription;

            if (paymentIntentId) {
                const paymentIntent = await stripe.paymentIntents.retrieve(paymentIntentId);

                subscription = await stripe.subscriptions.update(subscriptionId, {
                    default_payment_method: paymentIntent.payment_method
                });
            }
            else {
                subscription = await stripe.subscriptions.retrieve(subscriptionId);
            }

            if (subscription) {
                await updatePlan(subscription);
                return true;
            }

            return false;
        }
    }
};
