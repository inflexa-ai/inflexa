declare global {
    interface PromiseConstructor {
        /**
         * The await-able equivalent of setTimeout — resolves after `ms`. Lives as a
         * static on Promise so retry/poll loops can pace themselves without each module
         * redeclaring its own one-line helper.
         */
        sleep(ms: number): Promise<void>;
    }
}

Promise.sleep = function (ms: number): Promise<void> {
    return new Promise((resolve) => {
        setTimeout(resolve, ms);
    });
};

export {};
