const _PROD_FIREBASE_CONFIG = {
    apiKey: process.env.VUE_APP_FIREBASE_API_KEY,
    authDomain: process.env.VUE_APP_FIREBASE_AUTH_DOMAIN,
    databaseURL: process.env.VUE_APP_FIREBASE_DATABASE_URL,
    projectId: process.env.VUE_APP_FIREBASE_PROJECT_ID,
    storageBucket: process.env.VUE_APP_FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.VUE_APP_MESSAGING_SENDER_ID,
    appId: process.env.VUE_APP_FIREBASE_APP_ID
};

const _DEV_FIREBASE_CONFIG = {
    apiKey: '123',
    databaseURL: process.env.VUE_APP_FIREBASE_DATABASE_URL + '?ns=ethernal-95a14-default-rtdb',
    projectId: 'ethernal-95a14'
};

export const FIREBASE_CONFIG = process.env.NODE_ENV == 'development' ? _DEV_FIREBASE_CONFIG : _PROD_FIREBASE_CONFIG;
